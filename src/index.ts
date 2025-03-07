import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const fsReadFileAsync = fs.promises.readFile;

export type LilconfigResult = null | {
    filepath: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any;
    isEmpty?: boolean;
};

interface OptionsBase {
    cache?: boolean;
    stopDir?: string;
    searchPlaces?: string[];
    ignoreEmptySearchPlaces?: boolean;
    packageProp?: string | string[];
}

export type Transform =
    | TransformSync
    | ((result: LilconfigResult) => Promise<LilconfigResult>);
export type TransformSync = (result: LilconfigResult) => LilconfigResult;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoaderResult = any;
export type LoaderSync = (filepath: string, content: string) => LoaderResult;
export type Loader =
    | LoaderSync
    | ((filepath: string, content: string) => Promise<LoaderResult>);
export type Loaders = Record<string, Loader>;
export type LoadersSync = Record<string, LoaderSync>;

export interface Options extends OptionsBase {
    loaders?: Loaders;
    transform?: Transform;
}

export interface OptionsSync extends OptionsBase {
    loaders?: LoadersSync;
    transform?: TransformSync;
}

function getDefaultSearchPlaces(name: string, sync: boolean): string[] {
    return [
        'package.json',
        `.${name}rc.json`,
        `.${name}rc.js`,
        `.${name}rc.cjs`,
        ...(sync ? [] : [`.${name}rc.mjs`]),
        `.config/${name}rc`,
        `.config/${name}rc.json`,
        `.config/${name}rc.js`,
        `.config/${name}rc.cjs`,
        ...(sync ? [] : [`.config/${name}rc.mjs`]),
        `${name}.config.js`,
        `${name}.config.cjs`,
        ...(sync ? [] : [`${name}.config.mjs`]),
    ];
}

/**
 * @see #17
 * On *nix, if cwd is not under homedir,
 * the last path will be '', ('/build' -> '')
 * but it should be '/' actually.
 * And on Windows, this will never happen. ('C:\build' -> 'C:')
 */
function parentDir(p: string): string {
    return path.dirname(p) || path.sep;
}

const jsonLoader: LoaderSync = (_, content) => JSON.parse(content);
export const defaultLoadersSync: LoadersSync = Object.freeze({
    '.js': require,
    '.json': require,
    '.cjs': require,
    noExt: jsonLoader,
});

const dynamicImport = async (id: string) => {
    try {
        // @ts-expect-error typescript is nice
        const mod = await TS_IMPORT(id);

        return mod.default;
    } catch (e) {
        try {
            return require(id);
        } catch (requireE: any) {
            if (
                requireE.code === 'ERR_REQUIRE_ESM' ||
                (requireE instanceof SyntaxError &&
                    requireE
                        .toString()
                        .includes(
                            'Cannot use import statement outside a module',
                        ))
            ) {
                throw e;
            }
            throw requireE;
        }
    }
};

export const defaultLoaders: Loaders = Object.freeze({
    '.js': dynamicImport,
    '.mjs': dynamicImport,
    '.cjs': dynamicImport,
    '.json': jsonLoader,
    noExt: jsonLoader,
});

function getOptions(
    name: string,
    options: OptionsSync,
    sync: true,
): Required<OptionsSync>;
function getOptions(
    name: string,
    options: Options,
    sync: false,
): Required<Options>;
function getOptions(
    name: string,
    options: Options | OptionsSync,
    sync: boolean,
): Required<Options | OptionsSync> {
    const conf: Required<Options> = {
        stopDir: os.homedir(),
        searchPlaces: getDefaultSearchPlaces(name, sync),
        ignoreEmptySearchPlaces: true,
        cache: true,
        transform: (x: LilconfigResult): LilconfigResult => x,
        packageProp: [name],
        ...options,
        loaders: {
            ...(sync ? defaultLoadersSync : defaultLoaders),
            ...options.loaders,
        },
    };
    conf.searchPlaces.forEach(place => {
        const key = path.extname(place) || 'noExt';
        const loader = conf.loaders[key];
        if (!loader) {
            throw new Error(`Missing loader for extension "${place}"`);
        }

        if (typeof loader !== 'function') {
            throw new Error(
                `Loader for extension "${place}" is not a function: Received ${typeof loader}.`,
            );
        }
    });

    return conf;
}

function getPackageProp(
    props: string | string[],
    obj: Record<string, unknown>,
): unknown {
    if (typeof props === 'string' && props in obj) return obj[props];
    return (
        (Array.isArray(props) ? props : props.split('.')).reduce(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (acc: any, prop): unknown => (acc === undefined ? acc : acc[prop]),
            obj,
        ) || null
    );
}

function validateFilePath(filepath: string): void {
    if (!filepath) throw new Error('load must pass a non-empty string');
}

function validateLoader(loader: Loader, ext: string): void | never {
    if (!loader) throw new Error(`No loader specified for extension "${ext}"`);
    if (typeof loader !== 'function')
        throw new Error('loader is not a function');
}

type ClearCaches = {
    clearLoadCache: () => void;
    clearSearchCache: () => void;
    clearCaches: () => void;
};

const makeEmplace =
    <T extends LilconfigResult | Promise<LilconfigResult>>(
        enableCache: boolean,
    ) =>
    (c: Map<string, T>, filepath: string, res: T): T => {
        if (enableCache) c.set(filepath, res);
        return res;
    };

type AsyncSearcher = {
    search(searchFrom?: string): Promise<LilconfigResult>;
    load(filepath: string): Promise<LilconfigResult>;
} & ClearCaches;

export function lilconfig(
    name: string,
    options?: Partial<Options>,
): AsyncSearcher {
    const {
        ignoreEmptySearchPlaces,
        loaders,
        packageProp,
        searchPlaces,
        stopDir,
        transform,
        cache,
    } = getOptions(name, options ?? {}, false);
    type R = LilconfigResult | Promise<LilconfigResult>;
    const searchCache = new Map<string, R>();
    const loadCache = new Map<string, R>();
    const emplace = makeEmplace<R>(cache);

    return {
        async search(searchFrom = process.cwd()): Promise<LilconfigResult> {
            const result: LilconfigResult = {
                config: null,
                filepath: '',
            };

            const visited: Set<string> = new Set();
            let dir = searchFrom;
            dirLoop: while (true) {
                if (cache) {
                    const r = searchCache.get(dir);
                    if (r !== undefined) {
                        for (const p of visited) searchCache.set(p, r);
                        return r;
                    }
                    visited.add(dir);
                }

                for (const searchPlace of searchPlaces) {
                    const filepath = path.join(dir, searchPlace);
                    try {
                        await fs.promises.access(filepath);
                    } catch {
                        continue;
                    }
                    const content = String(await fsReadFileAsync(filepath));
                    const loaderKey = path.extname(searchPlace) || 'noExt';
                    const loader = loaders[loaderKey];

                    // handle package.json
                    if (searchPlace === 'package.json') {
                        const pkg = await loader(filepath, content);
                        const maybeConfig = getPackageProp(packageProp, pkg);
                        if (maybeConfig != null) {
                            result.config = maybeConfig;
                            result.filepath = filepath;
                            break dirLoop;
                        }

                        continue;
                    }

                    // handle other type of configs
                    const isEmpty = content.trim() === '';
                    if (isEmpty && ignoreEmptySearchPlaces) continue;

                    if (isEmpty) {
                        result.isEmpty = true;
                        result.config = undefined;
                    } else {
                        validateLoader(loader, loaderKey);
                        result.config = await loader(filepath, content);
                    }
                    result.filepath = filepath;
                    break dirLoop;
                }
                if (dir === stopDir || dir === parentDir(dir)) break dirLoop;
                dir = parentDir(dir);
            }

            const transformed =
                // not found
                result.filepath === '' && result.config === null
                    ? transform(null)
                    : transform(result);

            if (cache) {
                for (const p of visited) searchCache.set(p, transformed);
            }

            return transformed;
        },
        async load(filepath: string): Promise<LilconfigResult> {
            validateFilePath(filepath);
            const absPath = path.resolve(process.cwd(), filepath);
            if (cache && loadCache.has(absPath)) {
                return loadCache.get(absPath) as LilconfigResult;
            }
            const {base, ext} = path.parse(absPath);
            const loaderKey = ext || 'noExt';
            const loader = loaders[loaderKey];
            validateLoader(loader, loaderKey);
            const content = String(await fsReadFileAsync(absPath));

            if (base === 'package.json') {
                const pkg = await loader(absPath, content);
                return emplace(
                    loadCache,
                    absPath,
                    transform({
                        config: getPackageProp(packageProp, pkg),
                        filepath: absPath,
                    }),
                );
            }
            const result: LilconfigResult = {
                config: null,
                filepath: absPath,
            };
            // handle other type of configs
            const isEmpty = content.trim() === '';
            if (isEmpty && ignoreEmptySearchPlaces)
                return emplace(
                    loadCache,
                    absPath,
                    transform({
                        config: undefined,
                        filepath: absPath,
                        isEmpty: true,
                    }),
                );

            // cosmiconfig returns undefined for empty files
            result.config = isEmpty
                ? undefined
                : await loader(absPath, content);

            return emplace(
                loadCache,
                absPath,
                transform(
                    isEmpty ? {...result, isEmpty, config: undefined} : result,
                ),
            );
        },
        clearLoadCache() {
            if (cache) loadCache.clear();
        },
        clearSearchCache() {
            if (cache) searchCache.clear();
        },
        clearCaches() {
            if (cache) {
                loadCache.clear();
                searchCache.clear();
            }
        },
    };
}

type SyncSearcher = {
    search(searchFrom?: string): LilconfigResult;
    load(filepath: string): LilconfigResult;
} & ClearCaches;

export function lilconfigSync(
    name: string,
    options?: OptionsSync,
): SyncSearcher {
    const {
        ignoreEmptySearchPlaces,
        loaders,
        packageProp,
        searchPlaces,
        stopDir,
        transform,
        cache,
    } = getOptions(name, options ?? {}, true);
    type R = LilconfigResult;
    const searchCache = new Map<string, R>();
    const loadCache = new Map<string, R>();
    const emplace = makeEmplace<R>(cache);

    return {
        search(searchFrom = process.cwd()): LilconfigResult {
            const result: LilconfigResult = {
                config: null,
                filepath: '',
            };

            const visited: Set<string> = new Set();
            let dir = searchFrom;
            dirLoop: while (true) {
                if (cache) {
                    const r = searchCache.get(dir);
                    if (r !== undefined) {
                        for (const p of visited) searchCache.set(p, r);
                        return r;
                    }
                    visited.add(dir);
                }

                for (const searchPlace of searchPlaces) {
                    const filepath = path.join(dir, searchPlace);
                    try {
                        fs.accessSync(filepath);
                    } catch {
                        continue;
                    }
                    const loaderKey = path.extname(searchPlace) || 'noExt';
                    const loader = loaders[loaderKey];
                    const content = String(fs.readFileSync(filepath));

                    // handle package.json
                    if (searchPlace === 'package.json') {
                        const pkg = loader(filepath, content);
                        const maybeConfig = getPackageProp(packageProp, pkg);
                        if (maybeConfig != null) {
                            result.config = maybeConfig;
                            result.filepath = filepath;
                            break dirLoop;
                        }

                        continue;
                    }

                    // handle other type of configs
                    const isEmpty = content.trim() === '';
                    if (isEmpty && ignoreEmptySearchPlaces) continue;

                    if (isEmpty) {
                        result.isEmpty = true;
                        result.config = undefined;
                    } else {
                        validateLoader(loader, loaderKey);
                        result.config = loader(filepath, content);
                    }
                    result.filepath = filepath;
                    break dirLoop;
                }
                if (dir === stopDir || dir === parentDir(dir)) break dirLoop;
                dir = parentDir(dir);
            }

            const transformed =
                // not found
                result.filepath === '' && result.config === null
                    ? transform(null)
                    : transform(result);

            if (cache) {
                for (const p of visited) searchCache.set(p, transformed);
            }

            return transformed;
        },
        load(filepath: string): LilconfigResult {
            validateFilePath(filepath);
            const absPath = path.resolve(process.cwd(), filepath);
            if (cache && loadCache.has(absPath)) {
                return loadCache.get(absPath) as LilconfigResult;
            }
            const {base, ext} = path.parse(absPath);
            const loaderKey = ext || 'noExt';
            const loader = loaders[loaderKey];
            validateLoader(loader, loaderKey);

            const content = String(fs.readFileSync(absPath));

            if (base === 'package.json') {
                const pkg = loader(absPath, content);
                return transform({
                    config: getPackageProp(packageProp, pkg),
                    filepath: absPath,
                });
            }
            const result: LilconfigResult = {
                config: null,
                filepath: absPath,
            };
            // handle other type of configs
            const isEmpty = content.trim() === '';
            if (isEmpty && ignoreEmptySearchPlaces)
                return emplace(
                    loadCache,
                    absPath,
                    transform({
                        filepath: absPath,
                        config: undefined,
                        isEmpty: true,
                    }),
                );

            // cosmiconfig returns undefined for empty files
            result.config = isEmpty ? undefined : loader(absPath, content);

            return emplace(
                loadCache,
                absPath,
                transform(
                    isEmpty ? {...result, isEmpty, config: undefined} : result,
                ),
            );
        },
        clearLoadCache() {
            if (cache) loadCache.clear();
        },
        clearSearchCache() {
            if (cache) searchCache.clear();
        },
        clearCaches() {
            if (cache) {
                loadCache.clear();
                searchCache.clear();
            }
        },
    };
}
