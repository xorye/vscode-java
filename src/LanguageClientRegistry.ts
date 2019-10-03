import { window } from 'vscode';
import { LanguageClient } from 'vscode-languageclient';

interface Registry {
  [extensionId: string]: LanguageClient;
}

interface PendingBind {
  fromExtensionId: string;
  toExtensionId: string;
  fromExtensionRegistered: boolean;
  toExtensionRegistered: boolean;
  request: string;
  resolve: (value?: unknown) => void;
}

const registry: Registry = {};
export { registry };

const pendingBinds: PendingBind[] = [];

const handler = {
  set: (registry, extensionId, value, receiver) => {
    registry[extensionId] = value;

    updatePendingRequests(extensionId);
    resolvePendingRequestsIfPossible();

    return true;
  }
};

function updatePendingRequests(extensionId: string): void {
  pendingBinds.forEach((request: PendingBind) => {
    if (request.fromExtensionId === extensionId) {
      request.fromExtensionRegistered = true;
    }

    if (request.toExtensionId === extensionId) {
      request.toExtensionRegistered = true;
    }
  });
}

function resolvePendingRequestsIfPossible(): void {
  pendingBinds.forEach((request: PendingBind, index: number, object: PendingBind[]) => {
    if (request.fromExtensionRegistered && request.toExtensionRegistered) {
      LanguageClientRegistry.bindRequestSync(request.fromExtensionId, request.toExtensionId, request.request);
      request.resolve();
      object.splice(index, 1);
    }
  });
}

const registryProxy = new Proxy(registry, handler);

export class LanguageClientRegistry {

  /**
   * Registers a languageClient into the registry
   * @param extensionId
   * @param languageClient
   */
  static register(extensionId: string, languageClient: LanguageClient): void {
    registryProxy[extensionId] = languageClient;
  }

  /**
   * Binds a `request` request from `registry[fromExtensionId]` to `registry[toExtensionId]`
   *
   * If the registry currently contains a LanguageClient instance for both `fromExtensionId` and `toExtenionId`,
   * the request will bind and the promise will resolve almost immediately
   *
   * If the registry does not contain a LanguageClient instance for `fromExtensionId` or `toExtensionId`
   * (or both), the promise will be pending until the missing LanguageClient(s) are registered in the registry.
   *
   * When the promise resolves, this means that both LanguageClients are in the registry and the request has been binded.
   * @param fromExtensionId
   * @param toExtensionId
   * @param request
   */
  static bindRequest(fromExtensionId: string, toExtensionId: string, request: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (registryProxy.hasOwnProperty(toExtensionId) && registryProxy.hasOwnProperty(fromExtensionId)) {
        LanguageClientRegistry.bindRequestSync(fromExtensionId, toExtensionId, request);
        resolve();
      } else {

        const pendingRequest = {
          fromExtensionId,
          toExtensionId,
          fromExtensionRegistered: registryProxy.hasOwnProperty(fromExtensionId) as boolean,
          toExtensionRegistered: registryProxy.hasOwnProperty(toExtensionId) as boolean,
          request,
          resolve
        };
        pendingBinds.push(pendingRequest);
      }
    });
  }

  /**
   * Synchronous version of `bindRequest`, however, this function assumes that the registry contains
   * LanguageClient instances for both `fromExtensionId` and `toExtensionId`.
   *
   * If not, this function will throw an error.
   * @param fromExtensionId
   * @param toExtensionId
   * @param request
   */
  static bindRequestSync(fromExtensionId: string, toExtensionId: string, request: string): void {
    const fromLanguageClient: LanguageClient = registryProxy[fromExtensionId];
    const toLanguageClient: LanguageClient = registryProxy[toExtensionId];
    fromLanguageClient.onRequest(request, async(params: any) => {
      window.showInformationMessage(`Delegating ${request} request from ${fromExtensionId} to ${toExtensionId}.` );
      return <any> await toLanguageClient.sendRequest(request, params);
    });
  }
}
