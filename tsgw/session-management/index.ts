/** Node-only public entry; no browser imports. */
export { createSessionManagementExtension, SESSION_MANAGEMENT_TOOL_NAMES } from "./extension";
export { isOrdinarySession, listSessionCatalog, projectSessions, sessionDirectoryKey } from "./catalog";
export { withNotificationAdmission, type NotificationWrapper } from "./notification-admission";
export { archiveManagedSession, listManagedSessions, readManagedSession, renameManagedSession } from "./service";
