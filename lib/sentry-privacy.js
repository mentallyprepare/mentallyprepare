'use strict';

// Crash stack traces are useful; request and breadcrumb URLs can contain push
// tokens, backup object names, account paths, or private user content.
function discardBreadcrumb() {
  return null;
}

function sanitizeCrashEvent(event) {
  if (!event || typeof event !== 'object') return event;
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.tags;
  return event;
}

module.exports = { discardBreadcrumb, sanitizeCrashEvent };
