// ESM loader for tests to intercept https://esm.sh/ imports in Node.js
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('https://')) {
    const mock = `
      export class App {
        getHostContext() { return {}; }
        connect() { return Promise.resolve(); }
        callServerTool() { return Promise.resolve({ structuredContent: { ok: true, rows: [] } }); }
      }
      export class QueryClient {
        constructor(options = {}) {
          this.defaultOptions = options.defaultOptions || {};
        }
      }
      export const QueryClientProvider = () => null;
      export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
      export const useEffect = () => {};
      export const useLayoutEffect = () => {};
      export const useMemo = (fn) => fn();
      export const useRef = (val) => ({ current: val });
      export const useCallback = (fn) => fn;
      export const useReducer = (r, init) => [init, () => {}];
      export const useQuery = (options) => {
        if (typeof globalThis.__mockUseQuery === 'function') {
          return globalThis.__mockUseQuery(options);
        }
        const cfg = globalThis.__mockUseQueryConfig || {};
        if (Array.isArray(globalThis.__lastQueryOptions)) {
          globalThis.__lastQueryOptions.push(options);
        } else {
          globalThis.__lastQueryOptions = [options];
        }
        const isError = typeof cfg.isError === 'boolean' ? cfg.isError : false;
        const isLoading = typeof cfg.isLoading === 'boolean' ? cfg.isLoading : false;
        const data = typeof cfg.data !== 'undefined'
          ? (typeof cfg.data === 'function' ? cfg.data(options) : cfg.data)
          : (options && options.placeholderData);
        return {
          data,
          isLoading,
          isError,
          error: cfg.error || (isError ? new Error('Mock query error') : null),
          refetch: () => {
            if (typeof globalThis.__mockQueryRefetched === 'function') {
              globalThis.__mockQueryRefetched(options);
            }
          },
        };
      };
      export const useMutation = () => ({ mutate: () => {}, isPending: false });
      export const useQueryClient = () => ({ invalidateQueries: () => {} });
      export const useAutoGrow = () => {};
      export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.flat() } });
      const htmBind = (cr) => (strings, ...values) => {
        let str = '';
        for (let i = 0; i < strings.length; i++) {
          str += strings[i];
          if (i < values.length) {
            const v = values[i];
            if (typeof v === 'string' || typeof v === 'number') str += v;
            else if (v && typeof v === 'object' && v.type) str += '[element:' + (typeof v.type === 'string' ? v.type : ((v.type && v.type.name) || 'element')) + (v.str ? ' ' + v.str : '') + ']';
            else if (typeof v === 'function') {
              str += '[component:' + (v.name || 'anonymous') + ']';
              try {
                const rendered = v({});
                if (rendered && rendered.str) str += ' ' + rendered.str;
              } catch (_) {}
            }
          }
        }
        return { type: 'vnode', str, strings, values };
      };
      export default { bind: htmBind };
      export const cn = (...args) => args.filter(Boolean).join(' ');
      export const Icon = (props) => ({ type: 'icon', props });
    `;
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(mock)}`,
    };
  }
  return nextResolve(specifier, context);
}

export function setMockQueryConfig(cfg) {
  globalThis.__mockUseQuery = null;
  globalThis.__mockUseQueryConfig = cfg;
  globalThis.__lastQueryOptions = [];
}

export function getQueryCalls() {
  return globalThis.__lastQueryOptions || [];
}

export function getLastQueryOptions() {
  const calls = globalThis.__lastQueryOptions || [];
  return calls[calls.length - 1];
}

export function resetMockQuery() {
  globalThis.__mockUseQueryConfig = null;
  globalThis.__mockUseQuery = null;
  globalThis.__lastQueryOptions = [];
}

