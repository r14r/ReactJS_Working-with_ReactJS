// @flow strict-local

import type {
  AsyncSubscription,
  BundleGraph as IBundleGraph,
  BuildEvent,
  EnvironmentOpts,
  FilePath,
  InitialParcelOptions,
  ModuleSpecifier,
  NamedBundle as INamedBundle,
} from '@parcel/types';
import type {AssetRequestResult, ParcelOptions} from './types';
import type {FarmOptions} from '@parcel/workers';
import type {Diagnostic} from '@parcel/diagnostic';
import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
// eslint-disable-next-line no-unused-vars
import type ParcelConfig from './ParcelConfig';

import invariant from 'assert';
import ThrowableDiagnostic, {anyToDiagnostic} from '@parcel/diagnostic';
import {createDependency} from './Dependency';
import {createEnvironment} from './Environment';
import {assetFromValue} from './public/Asset';
import {NamedBundle} from './public/Bundle';
import BundleGraph from './public/BundleGraph';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import nullthrows from 'nullthrows';
import AssetGraphBuilder from './AssetGraphBuilder';
import {assertSignalNotAborted, BuildAbortError} from './utils';
import PackagerRunner from './PackagerRunner';
import {loadParcelConfig} from './requests/ParcelConfigRequest';
import ReporterRunner, {report} from './ReporterRunner';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import resolveOptions from './resolveOptions';
import {ValueEmitter} from '@parcel/events';
import {registerCoreWithSerializer} from './utils';
import {createCacheDir} from '@parcel/cache';
import {AbortController} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import {PromiseQueue} from '@parcel/utils';
import logger from '@parcel/logger';

registerCoreWithSerializer();

export const INTERNAL_TRANSFORM: symbol = Symbol('internal_transform');
export const INTERNAL_RESOLVE: symbol = Symbol('internal_resolve');

export default class Parcel {
  #assetGraphBuilder /*: AssetGraphBuilder*/;
  #runtimesAssetGraphBuilder /*: AssetGraphBuilder*/;
  #bundlerRunner /*: BundlerRunner*/;
  #packagerRunner /*: PackagerRunner*/;
  #config /*: ParcelConfig*/;
  #farm /*: WorkerFarm*/;
  #initialized /*: boolean*/ = false;
  #initialOptions /*: InitialParcelOptions*/;
  #reporterRunner /*: ReporterRunner*/;
  #resolvedOptions /*: ?ParcelOptions*/ = null;
  #watchAbortController /*: AbortController*/;
  #watchQueue /*: PromiseQueue<?BuildEvent>*/ = new PromiseQueue<?BuildEvent>({
    maxConcurrent: 1,
  });
  #watchEvents /*: ValueEmitter<
    | {|
        +error: Error,
        +buildEvent?: void,
      |}
    | {|
        +buildEvent: BuildEvent,
        +error?: void,
      |},
  > */ = new ValueEmitter<
    | {|
        +error: Error,
        +buildEvent?: void,
      |}
    | {|
        +buildEvent: BuildEvent,
        +error?: void,
      |},
  >();
  #watcherSubscription /*: ?AsyncSubscription*/;
  #watcherCount /*: number*/ = 0;

  isProfiling /*: boolean */;

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = options;
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions,
    );
    this.#resolvedOptions = resolvedOptions;
    await createCacheDir(resolvedOptions.outputFS, resolvedOptions.cacheDir);
    let {config} = await loadParcelConfig(resolvedOptions);
    this.#config = config;
    this.#farm =
      this.#initialOptions.workerFarm ??
      createWorkerFarm({
        patchConsole: resolvedOptions.patchConsole,
      });

    // ? Should we have a dispose function on the Parcel class or should we create these references
    //  - in run and watch and dispose at the end of run and in the unsubsribe function of watch
    let {ref: optionsRef} = await this.#farm.createSharedReference(
      resolvedOptions,
    );
    let {ref: configRef} = await this.#farm.createSharedReference(
      config.getConfig(),
    );

    this.#assetGraphBuilder = new AssetGraphBuilder();
    this.#runtimesAssetGraphBuilder = new AssetGraphBuilder();

    await Promise.all([
      this.#assetGraphBuilder.init({
        name: 'MainAssetGraph',
        options: resolvedOptions,
        optionsRef,
        entries: resolvedOptions.entries,
        workerFarm: this.#farm,
      }),
      this.#runtimesAssetGraphBuilder.init({
        name: 'RuntimesAssetGraph',
        options: resolvedOptions,
        optionsRef,
        workerFarm: this.#farm,
      }),
    ]);

    this.#bundlerRunner = new BundlerRunner({
      options: resolvedOptions,
      runtimesBuilder: this.#runtimesAssetGraphBuilder,
      config,
      workerFarm: this.#farm,
    });

    this.#reporterRunner = new ReporterRunner({
      config,
      options: resolvedOptions,
      workerFarm: this.#farm,
    });

    this.#packagerRunner = new PackagerRunner({
      config,
      farm: this.#farm,
      options: resolvedOptions,
      optionsRef,
      configRef,
      report,
    });

    this.#initialized = true;
  }

  async run(): Promise<IBundleGraph<INamedBundle>> {
    let startTime = Date.now();
    if (!this.#initialized) {
      await this.init();
    }

    let result = await this.build({startTime});
    await Promise.all([
      this.#assetGraphBuilder.writeToCache(),
      this.#runtimesAssetGraphBuilder.writeToCache(),
    ]);

    if (!this.#initialOptions.workerFarm) {
      // If there wasn't a workerFarm passed in, we created it. End the farm.
      await this.#farm.end();
    }

    if (result.type === 'buildFailure') {
      throw new BuildError(result.diagnostics);
    }

    return result.bundleGraph;
  }

  async startNextBuild() {
    this.#watchAbortController = new AbortController();

    try {
      this.#watchEvents.emit({
        buildEvent: await this.build({
          signal: this.#watchAbortController.signal,
        }),
      });
    } catch (err) {
      // Ignore BuildAbortErrors and only emit critical errors.
      if (!(err instanceof BuildAbortError)) {
        throw err;
      }
    }
  }

  async watch(
    cb?: (err: ?Error, buildEvent?: BuildEvent) => mixed,
  ): Promise<AsyncSubscription> {
    let watchEventsDisposable;
    if (cb) {
      watchEventsDisposable = this.#watchEvents.addListener(
        ({error, buildEvent}) => cb(error, buildEvent),
      );
    }

    if (this.#watcherCount === 0) {
      if (!this.#initialized) {
        await this.init();
      }

      this.#watcherSubscription = await this._getWatcherSubscription();
      await this.#reporterRunner.report({type: 'watchStart'});

      // Kick off a first build, but don't await its results. Its results will
      // be provided to the callback.
      this.#watchQueue.add(() => this.startNextBuild());
      this.#watchQueue.run();
    }

    this.#watcherCount++;

    let unsubscribePromise;
    const unsubscribe = async () => {
      if (watchEventsDisposable) {
        watchEventsDisposable.dispose();
      }

      this.#watcherCount--;
      if (this.#watcherCount === 0) {
        await nullthrows(this.#watcherSubscription).unsubscribe();
        this.#watcherSubscription = null;
        await this.#reporterRunner.report({type: 'watchEnd'});
        await Promise.all([
          this.#assetGraphBuilder.writeToCache(),
          this.#runtimesAssetGraphBuilder.writeToCache(),
        ]);
      }
    };

    return {
      unsubscribe() {
        if (unsubscribePromise == null) {
          unsubscribePromise = unsubscribe();
        }

        return unsubscribePromise;
      },
    };
  }

  async build({
    signal,
    startTime = Date.now(),
  }: {|
    signal?: AbortSignal,
    startTime?: number,
  |}): Promise<BuildEvent> {
    let options = nullthrows(this.#resolvedOptions);
    try {
      if (options.profile) {
        await this.startProfiling();
      }
      this.#reporterRunner.report({
        type: 'buildStart',
      });
      let {assetGraph, changedAssets} = await this.#assetGraphBuilder.build(
        signal,
      );
      dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');

      // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381
      let bundleGraph = await this.#bundlerRunner.bundle(assetGraph, {signal});
      // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
      dumpGraphToGraphViz(bundleGraph._graph, 'BundleGraph');

      await this.#packagerRunner.writeBundles(bundleGraph);
      assertSignalNotAborted(signal);

      let event = {
        type: 'buildSuccess',
        changedAssets: new Map(
          Array.from(changedAssets).map(([id, asset]) => [
            id,
            assetFromValue(asset, options),
          ]),
        ),
        bundleGraph: new BundleGraph(bundleGraph, NamedBundle.get, options),
        buildTime: Date.now() - startTime,
      };

      await this.#reporterRunner.report(event);

      await this.#assetGraphBuilder.validate();
      return event;
    } catch (e) {
      if (e instanceof BuildAbortError) {
        throw e;
      }

      let diagnostic = anyToDiagnostic(e);
      let event = {
        type: 'buildFailure',
        diagnostics: Array.isArray(diagnostic) ? diagnostic : [diagnostic],
      };

      await this.#reporterRunner.report(event);

      return event;
    } finally {
      if (this.isProfiling) {
        await this.stopProfiling();
      }
    }
  }

  // $FlowFixMe
  async [INTERNAL_TRANSFORM]({
    filePath,
    env,
    code,
  }: {|
    filePath: FilePath,
    env: EnvironmentOpts,
    code?: string,
  |}): Promise<AssetRequestResult> {
    let [result] = await Promise.all([
      this.#assetGraphBuilder.runTransform({
        filePath,
        code,
        env: createEnvironment(env),
      }),
      this.#reporterRunner.config.getReporters(),
    ]);

    return result;
  }

  // $FlowFixMe
  async [INTERNAL_RESOLVE]({
    moduleSpecifier,
    sourcePath,
    env,
  }: {|
    moduleSpecifier: ModuleSpecifier,
    sourcePath: FilePath,
    env: EnvironmentOpts,
  |}): Promise<FilePath> {
    let resolved = await this.#assetGraphBuilder.resolverRunner.resolve(
      createDependency({
        moduleSpecifier,
        sourcePath,
        env: createEnvironment(env),
      }),
    );

    return resolved.filePath;
  }

  _getWatcherSubscription(): Promise<AsyncSubscription> {
    invariant(this.#watcherSubscription == null);

    let resolvedOptions = nullthrows(this.#resolvedOptions);
    let opts = this.#assetGraphBuilder.getWatcherOptions();
    return resolvedOptions.inputFS.watch(
      resolvedOptions.projectRoot,
      (err, events) => {
        if (err) {
          this.#watchEvents.emit({error: err});
          return;
        }

        let isInvalid = this.#assetGraphBuilder.respondToFSEvents(events);
        if (isInvalid && this.#watchQueue.getNumWaiting() === 0) {
          if (this.#watchAbortController) {
            this.#watchAbortController.abort();
          }

          this.#watchQueue.add(() => this.startNextBuild());
          this.#watchQueue.run();
        }
      },
      opts,
    );
  }

  // This is mainly for integration tests and it not public api!
  _getResolvedParcelOptions(): ParcelOptions {
    return nullthrows(
      this.#resolvedOptions,
      'Resolved options is null, please let parcel initialise before accessing this.',
    );
  }

  async startProfiling(): Promise<void> {
    if (this.isProfiling) {
      throw new Error('Parcel is already profiling');
    }

    logger.info({origin: '@parcel/core', message: 'Starting profiling...'});
    this.isProfiling = true;
    await this.#farm.startProfile();
  }

  stopProfiling(): Promise<void> {
    if (!this.isProfiling) {
      throw new Error('Parcel is not profiling');
    }

    logger.info({origin: '@parcel/core', message: 'Stopping profiling...'});
    this.isProfiling = false;
    return this.#farm.endProfile();
  }
}

export class BuildError extends ThrowableDiagnostic {
  constructor(diagnostics: Array<Diagnostic>) {
    super({diagnostic: diagnostics});

    this.name = 'BuildError';
  }
}

export function createWorkerFarm(
  options: $Shape<FarmOptions> = {},
): WorkerFarm {
  return new WorkerFarm({
    ...options,
    workerPath: require.resolve('./worker'),
  });
}