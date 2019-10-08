import { window } from 'vscode';
import { LanguageClient, NotificationType } from 'vscode-languageclient';

interface Registry {
  [extensionId: string]: LanguageClient;
}

interface PendingBind {
  fromExtensionId: string;
  toExtensionId: string;
  fromExtensionRegistered: boolean;
  toExtensionRegistered: boolean;
  request?: string;
  notification?: string;
  bindType: BindType;
  resolve: (value?: unknown) => void;
}

enum BindType {
  Request,
  Notification
}

const registry: Registry = {};
export { registry };

const pendingBinds: PendingBind[] = [];

function updatePendingBinds(extensionId: string): void {
  pendingBinds.forEach((request: PendingBind) => {
    if (request.fromExtensionId === extensionId) {
      request.fromExtensionRegistered = true;
    }

    if (request.toExtensionId === extensionId) {
      request.toExtensionRegistered = true;
    }
  });
}

function resolvePendingBindsIfPossible(): void {
  pendingBinds.forEach((pendingBind: PendingBind, index: number, object: PendingBind[]) => {
    if (pendingBind.fromExtensionRegistered && pendingBind.toExtensionRegistered) {

      switch (pendingBind.bindType) {
        case BindType.Request: {
          LanguageClientRegistry.bindRequestSync(pendingBind.fromExtensionId, pendingBind.toExtensionId, pendingBind.request);
          break;
        }
        case BindType.Notification: {
          LanguageClientRegistry.bindNotificationSync(pendingBind.fromExtensionId, pendingBind.toExtensionId, pendingBind.notification);
          break;
        }
        default: {
          // should never happen
          break;
        }
      }

      pendingBind.resolve();
      object.splice(index, 1);
    }
  });
}

export class LanguageClientRegistry {

  /**
   * Registers a languageClient into the registry
   * @param extensionId
   * @param languageClient
   */
  static register(extensionId: string, languageClient: LanguageClient): void {
    registry[extensionId] = languageClient;
    updatePendingBinds(extensionId);
    resolvePendingBindsIfPossible();
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
      if (registry.hasOwnProperty(toExtensionId) && registry.hasOwnProperty(fromExtensionId)) {
        LanguageClientRegistry.bindRequestSync(fromExtensionId, toExtensionId, request);
        resolve();
      } else {

        const pendingBind = {
          fromExtensionId,
          toExtensionId,
          fromExtensionRegistered: registry.hasOwnProperty(fromExtensionId) as boolean,
          toExtensionRegistered: registry.hasOwnProperty(toExtensionId) as boolean,
          request,
          bindType: BindType.Request,
          resolve
        };
        pendingBinds.push(pendingBind);
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
    const fromLanguageClient: LanguageClient = registry[fromExtensionId];
    const toLanguageClient: LanguageClient = registry[toExtensionId];
    fromLanguageClient.onRequest(request, async(params: any) => {
      return <any> await toLanguageClient.sendRequest(request, params);
    });
  }

  static bindNotification(fromExtensionId: string, toExtensionId: string, notification: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (registry.hasOwnProperty(toExtensionId) && registry.hasOwnProperty(fromExtensionId)) {
        LanguageClientRegistry.bindNotificationSync(fromExtensionId, toExtensionId, notification);
        resolve();
      } else {

        const pendingBind = {
          fromExtensionId,
          toExtensionId,
          fromExtensionRegistered: registry.hasOwnProperty(fromExtensionId) as boolean,
          toExtensionRegistered: registry.hasOwnProperty(toExtensionId) as boolean,
          notification,
          bindType: BindType.Notification,
          resolve
        };
        pendingBinds.push(pendingBind);
      }
    });
  }

  static bindNotificationSync(fromExtensionId: string, toExtensionId: string, notification: string): void {
    const fromLanguageClient: LanguageClient = registry[fromExtensionId];
    const toLanguageClient: LanguageClient = registry[toExtensionId];
    fromLanguageClient.onNotification(notification, async(params: any) => {
      return <any> await toLanguageClient.sendNotification(notification, params);
    });
  }
}
