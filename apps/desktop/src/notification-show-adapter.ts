import type { Notification } from 'electron';
import type {
  NativeNotificationEvents,
  NativeNotificationHandle,
} from './native-notifications';

type ElectronNotification = Pick<Notification, 'close' | 'once' | 'show'>;

export const showElectronNotification = (
  notification: ElectronNotification,
  events: NativeNotificationEvents,
): NativeNotificationHandle => {
  // Electron can emit `failed` while show() is executing, so every observer must
  // be installed before invoking the native API. Native error text stays here.
  notification.once('click', events.click);
  notification.once('close', events.close);
  notification.once('failed', () => events.failed());
  notification.once('show', events.shown);
  notification.show();
  return { close: () => notification.close() };
};
