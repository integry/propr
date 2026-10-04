# Inbox and Notifications

**Inbox** collects plan, task, review, pull-request, indexing and system events. Open an item to reach its relevant task, plan or goal. More items load as you browse; read/dismiss changes synchronize across tabs. Dismissing an item does not cancel the work behind it.

## Choose what reaches you

Open **Settings → Notifications** to choose Inbox and Push categories, quiet hours and badge behavior. These are personal preferences. In **Repositories → Settings**, the **Notifications** toggle suppresses future events for that repository across its branch entries. Automation continues, existing Inbox items remain, and system-health events are unaffected.

![Personal notification settings with Inbox and Push columns for each category and unread-count badge control](/img/screenshots/0.9.0/notifications.png)

## Install and enable push

Install the web app using your browser's install control. In Settings, choose **Enable on this browser** and grant notification permission, then enable Push for the desired categories. On supported iOS/iPadOS, add ProPR to the Home Screen in Safari and open that installed app before subscribing.

Browser support, HTTPS, permission and the server's push configuration determine delivery; an Inbox event does not guarantee an OS notification. See [PWA and Web Push operations](../operations/pwa-web-push.md) for VAPID configuration, proxy requirements, backup and recovery. Desktop native notifications and connection setup are covered in [Desktop](../operations/desktop-application.md).
