import type { ExecutorContext, ProjectGraphProjectNode } from '@nrwl/devkit';
import { readJsonFile } from '@nrwl/devkit';
import {
  copySync,
  readdirSync,
  readFileSync,
  removeSync,
  writeFileSync,
} from 'fs-extra';
import { join, relative } from 'path';
import type { NormalizedExecutorOptions } from './schema';

interface InlineProjectNode {
  name: string;
  root: string;
  sourceRoot: string;
  pathAlias: string;
  buildOutputPath?: string;
}

export interface InlineProjectGraph {
  nodes: Record<string, InlineProjectNode>;
  externals: Record<string, InlineProjectNode>;
  dependencies: Record<string, string[]>;
}

export function isInlineGraphEmpty(inlineGraph: InlineProjectGraph): boolean {
  return Object.keys(inlineGraph.nodes).length === 0;
}

export function handleInliningBuild(
  context: ExecutorContext,
  options: NormalizedExecutorOptions,
  tsConfigPath: string
): InlineProjectGraph {
  const tsConfigJson = readJsonFile(tsConfigPath);
  const pathAliases =
    tsConfigJson['compilerOptions']['paths'] || readBasePathAliases(context);
  const inlineGraph = createInlineGraph(context, options, pathAliases);

  if (isInlineGraphEmpty(inlineGraph)) {
    return inlineGraph;
  }

  buildInlineGraphExternals(context, inlineGraph, pathAliases);

  return inlineGraph;
}

export function postProcessInlinedDependencies(
  outputPath: string,
  parentOutputPath: string,
  inlineGraph: InlineProjectGraph
) {
  if (isInlineGraphEmpty(inlineGraph)) {
    return;
  }

  const parentDistPath = join(outputPath, parentOutputPath);

  // move parentOutput
  movePackage(parentDistPath, outputPath);

  const inlinedDepsDestOutputRecord: Record<string, string> = {};
  // move inlined outputs

  for (const inlineDependenciesNames of Object.values(
    inlineGraph.dependencies
  )) {
    for (const inlineDependenciesName of inlineDependenciesNames) {
      const inlineDependency = inlineGraph.nodes[inlineDependenciesName];
      const depOutputPath =
        inlineDependency.buildOutputPath ||
        join(outputPath, inlineDependency.root);
      const destDepOutputPath = join(outputPath, inlineDependency.name);
      movePackage(depOutputPath, destDepOutputPath);

      // TODO: hard-coded "src"
      inlinedDepsDestOutputRecord[inlineDependency.pathAlias] =
        destDepOutputPath + '/src';
    }
  }

  updateImports(outputPath, inlinedDepsDestOutputRecord);
}

function readBasePathAliases(context: ExecutorContext) {
  const tsConfigPath = join(context.root, 'tsconfig.base.json');
  return readJsonFile(tsConfigPath)?.['compilerOptions']['paths'] || {};
}

function emptyInlineGraph(): InlineProjectGraph {
  return { nodes: {}, externals: {}, dependencies: {} };
}

function projectNodeToInlineProjectNode(
  projectNode: ProjectGraphProjectNode,
  pathAlias = '',
  buildOutputPath = ''
): InlineProjectNode {
  return {
    name: projectNode.name,
    root: projectNode.data.root,
    sourceRoot: projectNode.data.sourceRoot,
    pathAlias,
    buildOutputPath,
  };
}

function createInlineGraph(
  context: ExecutorContext,
  options: NormalizedExecutorOptions,
  pathAliases: Record<string, string[]>,
  projectName: string = context.projectName,
  inlineGraph: InlineProjectGraph = emptyInlineGraph()
) {
  if (options.external == null) return inlineGraph;

  const projectDependencies =
    context.projectGraph.dependencies[projectName] || [];
  if (projectDependencies.length === 0) return inlineGraph;

  if (!inlineGraph.nodes[projectName]) {
    inlineGraph.nodes[projectName] = projectNodeToInlineProjectNode(
      context.projectGraph.nodes[projectName]
    );
  }

  const implicitDependencies =
    context.projectGraph.nodes[projectName].data.implicitDependencies || [];

  for (const projectDependency of projectDependencies) {
    // skip npm packages
    if (projectDependency.target.startsWith('npm')) {
      continue;
    }

    // skip implicitDependencies
    if (implicitDependencies.includes(projectDependency.target)) {
      continue;
    }

    const pathAlias = getPathAliasForPackage(
      context.projectGraph.nodes[projectDependency.target],
      pathAliases
    );

    const buildOutputPath = getBuildOutputPath(
      projectDependency.target,
      context,
      options
    );

    const shouldInline =
      /**
       * if all buildable libraries are marked as external,
       * then push the project dependency that doesn't have a build target
       */
      (options.external === 'all' && !buildOutputPath) ||
      /**
       * if all buildable libraries are marked as internal,
       * then push every project dependency to be inlined
       */
      options.external === 'none' ||
      /**
       * if some buildable libraries are marked as external,
       * then push the project dependency that IS NOT marked as external OR doesn't have a build target
       */
      (Array.isArray(options.external) &&
        options.external.length > 0 &&
        !options.external.includes(projectDependency.target)) ||
      !buildOutputPath;

    if (shouldInline) {
      inlineGraph.dependencies[projectName] ??= [];
      inlineGraph.dependencies[projectName].push(projectDependency.target);
    }

    inlineGraph.nodes[projectDependency.target] =
      projectNodeToInlineProjectNode(
        context.projectGraph.nodes[projectDependency.target],
        pathAlias,
        buildOutputPath
      );

    if (
      context.projectGraph.dependencies[projectDependency.target].length > 0
    ) {
      inlineGraph = createInlineGraph(
        context,
        options,
        pathAliases,
        projectDependency.target,
        inlineGraph
      );
    }
  }

  return inlineGraph;
}

function buildInlineGraphExternals(
  context: ExecutorContext,
  inlineProjectGraph: InlineProjectGraph,
  pathAliases: Record<string, string[]>
) {
  const allNodes = { ...context.projectGraph.nodes };

  for (const [parent, dependencies] of Object.entries(
    inlineProjectGraph.dependencies
  )) {
    if (allNodes[parent]) {
      delete allNodes[parent];
    }

    for (const dependencyName of dependencies) {
      const dependencyNode = inlineProjectGraph.nodes[dependencyName];

      // buildable is still external even if it is a dependency
      if (dependencyNode.buildOutputPath) {
        continue;
      }

      if (allNodes[dependencyName]) {
        delete allNodes[dependencyName];
      }
    }
  }

  for (const [projectName, projectNode] of Object.entries(allNodes)) {
    if (!inlineProjectGraph.externals[projectName]) {
      inlineProjectGraph.externals[projectName] =
        projectNodeToInlineProjectNode(
          projectNode,
          getPathAliasForPackage(projectNode, pathAliases)
        );
    }
  }
}

export function movePackage(from: string, to: string) {
  copySync(from, to, { overwrite: true, recursive: true });
  removeSync(from);
}

function updateImports(
  destOutputPath: string,
  inlinedDepsDestOutputRecord: Record<string, string>
) {
  const importRegex = new RegExp(
    Object.keys(inlinedDepsDestOutputRecord)
      .map((pathAlias) => `["'](${pathAlias})["']`)
      .join('|'),
    'g'
  );
  recursiveUpdateImport(
    destOutputPath,
    importRegex,
    inlinedDepsDestOutputRecord
  );
}

function recursiveUpdateImport(
  dirPath: string,
  importRegex: RegExp,
  inlinedDepsDestOutputRecord: Record<string, string>
) {
  const files = readdirSync(dirPath, { withFileTypes: true });
  for (const file of files) {
    // only check .js and .d.ts files
    if (
      file.isFile() &&
      (file.name.endsWith('.js') || file.name.endsWith('.d.ts'))
    ) {
      const filePath = join(dirPath, file.name);
      const fileContent = readFileSync(filePath, 'utf-8');
      const updatedContent = fileContent.replace(importRegex, (matched) => {
        const result = matched.replace(/['"]/g, '');
        return `"${relative(dirPath, inlinedDepsDestOutputRecord[result])}"`;
      });
      writeFileSync(filePath, updatedContent);
    } else if (file.isDirectory()) {
      recursiveUpdateImport(
        join(dirPath, file.name),
        importRegex,
        inlinedDepsDestOutputRecord
      );
    }
  }
}

function getPathAliasForPackage(
  packageNode: ProjectGraphProjectNode,
  pathAliases: Record<string, string[]>
): string {
  if (!packageNode) return '';

  for (const [alias, paths] of Object.entries(pathAliases)) {
    if (paths.some((path) => path.includes(packageNode.data.root))) {
      return alias;
    }
  }

  return '';
}

function getBuildOutputPath(
  projectName: string,
  context: ExecutorContext,
  options: NormalizedExecutorOptions
): string {
  const buildTarget = options.externalBuildTargets.find(
    (buildTarget) =>
      context.projectGraph.nodes[projectName]?.data?.targets?.[buildTarget]
  );

  if (buildTarget)
    return context.projectGraph.nodes[projectName].data.targets?.[buildTarget]
      .options['outputPath'];
  return '';
}
