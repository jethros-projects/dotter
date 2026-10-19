import { cliError, sdkError } from './sdk-error.mjs';

// Native call shapes are explicit here: lifecycle signals must reach the
// protocol method's actual options argument, rather than a guessed argument.
const TRANSPORT_OPTIONS = new Map([
  ['authLoader', 0], ['requestRealtimeSdp', 0],
  ['request', 2], ['requestMultipart', 2], ['requestBytes', 2],
  ['fetchImpl', 1], ['fetchSigned', 1], ['uploadSigned', 1],
  ['uploadSignedFile', 1], ['uploadEstuaryFile', 1],
  ['uploadAzureBlock', 1], ['commitAzureBlocks', 1], ['_uploadStorage', 1],
]);
const DOMAIN_OPTIONS = new Map([
  ['runtimeAction', 1], ['mcpRequest', 2], ['request', 2],
  ['readActivity', 1], ['socketSession', 1],
]);
const DOMAIN_SIGNALS = new Map([['resolveRoom', 1], ['resolveDot', 1]]);
const SYNC_HELPERS = new Set([
  'capabilities', 'headers', 'servicePrincipal', 'managerResponse',
  'now', 'setTimer', 'clearTimer', 'webSocketFactory',
]);
const DOMAINS = new Set([
  'client', 'operations', 'lifecycle', 'channels', 'extras', 'live',
  'connections', 'library', 'account', 'projects', 'projectFiles',
  'projectSharing', 'projectSources', 'projectSaves', 'projectMemory',
  'projectUpload', 'projectConnections', 'conversations', 'dotExtras',
  'messageWorkflows', 'mail', 'libraryContent', 'libraryUpload', 'sharing',
  'libraryProviders', 'routineManagement', 'connectorAdmin', 'plugins',
  'remoteControl', 'browserAuth', 'browserAuthNative', 'browserExtras',
  'nativeActions', 'onboarding', 'savedEntities',
]);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;

/** Guard native entrypoints without changing their receiver or stored state. */
export function createGuards({ assertOpen, execute, options = {}, settleOnAbort = () => false }) {
  const transports = new WeakMap(), domains = new WeakMap(), facades = new WeakSet();

  function sync(raw, method, native = false) {
    return (...args) => {
      assertOpen();
      try { return method.apply(raw, args); }
      catch (error) { throw native ? error : sdkError(error); }
    };
  }

  function transportMethod(raw, method, position) {
    return (...args) => {
      const input = args[position] ?? {};
      const timeoutMs = input.timeoutMs ?? options.requestTimeoutMs ?? 30_000;
      return execute({ signal: input.signal, timeoutMs }, signal => {
        args[position] = { ...input, timeoutMs, signal };
        return method.apply(raw, args);
      }).catch(error => {
        // Native domains inspect native error codes and HTTP details. Only the
        // outer SDK operation should project them into safe public errors.
        throw cliError(error);
      });
    };
  }

  function domainMethod(raw, key, method) {
    if (SYNC_HELPERS.has(key)) return sync(raw, method);
    if (DOMAIN_SIGNALS.has(key)) {
      const position = DOMAIN_SIGNALS.get(key);
      return (...args) => execute({ signal: args[position] }, signal => {
        args[position] = signal;
        return method.apply(raw, args);
      });
    }
    const position = DOMAIN_OPTIONS.get(key) ?? 0;
    return (...args) => {
      const input = args[position];
      const request = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      return execute({ signal: request.signal }, signal => {
        if (input === undefined || plain(input)) args[position] = { ...request, signal };
        return method.apply(raw, args);
      }, { settleOnAbort: settleOnAbort(method) });
    };
  }

  function facade(raw, cache, isTransport) {
    if (facades.has(raw)) return raw;
    if (cache.has(raw)) return cache.get(raw);
    const result = Object.create(Object.getPrototypeOf(raw)), methods = new Map(), scopedMethods = new WeakMap();
    cache.set(raw, result);
    facades.add(result);
    // Read descriptors once, but read current values on access. Direct calls
    // retain their original receiver, including private fields and frozen state.
    for (let owner = raw; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
      for (const key of Reflect.ownKeys(owner)) {
        if (key === 'constructor' || Object.hasOwn(result, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        Object.defineProperty(result, key, {
          enumerable: descriptor.enumerable,
          get() {
            assertOpen();
            const member = Reflect.get(raw, key, raw);
            if (typeof member === 'function') {
              // Native operations derive operation-local transports to pin an
              // auth loader. Their async methods must see those local overrides.
              const receiver = isTransport && this !== result && Object.prototype.isPrototypeOf.call(result, this) ? this : raw;
              let methodCache = methods;
              if (receiver !== raw) {
                if (!scopedMethods.has(receiver)) scopedMethods.set(receiver, new Map());
                methodCache = scopedMethods.get(receiver);
              }
              const cached = methodCache.get(key);
              if (cached?.original === member) return cached.guarded;
              const guarded = isTransport
                ? TRANSPORT_OPTIONS.has(key) ? transportMethod(receiver, member, TRANSPORT_OPTIONS.get(key)) : sync(raw, member, true)
                : domainMethod(raw, key, member);
              methodCache.set(key, { original: member, guarded });
              return guarded;
            }
            if (member && typeof member === 'object') {
              if (key === 'transport' && typeof member.request === 'function') return transport(member);
              if (!isTransport && DOMAINS.has(key) && !Array.isArray(member) && !(member instanceof Map) && !(member instanceof Set)) return domain(member);
            }
            return member;
          },
          set(value) {
            assertOpen();
            if (this === result) throw new TypeError('SDK handles are read-only.');
            Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true });
          },
        });
      }
    }
    return Object.freeze(result);
  }

  function transport(raw) { return facade(raw, transports, true); }
  function domain(raw) { return facade(raw, domains, false); }
  return { transport, domain };
}
