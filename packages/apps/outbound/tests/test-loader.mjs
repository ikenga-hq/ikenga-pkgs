// ESM loader for tests to intercept https://esm.sh/ imports in Node.js
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('https://')) {
    const mock = `
      export class App {
        getHostContext() { return {}; }
        connect() { return Promise.resolve(); }
        callServerTool() { return Promise.resolve({ structuredContent: { ok: true, rows: [] } }); }
      }
      export class QueryClient {}
      export const QueryClientProvider = () => null;
      export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
      export const useEffect = () => {};
      export const useMemo = (fn) => fn();
      export const useRef = (val) => ({ current: val });
      export const useCallback = (fn) => fn;
      export const useReducer = (r, init) => [init, () => {}];
      export const useQuery = () => ({ data: undefined, isLoading: false, isError: false, refetch: () => {} });
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
            else if (v && typeof v === 'object' && v.type) str += '[element:' + (typeof v.type === 'string' ? v.type : v.type.name) + ']';
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
