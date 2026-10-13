import * as identity from './identity';

export class TabGroupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TabGroupError';
  }
}

export function groupName(value?: string): string {
  const name = value?.trim();
  if (!name) throw new TabGroupError('tab_group_name_required', 'Provide a non-empty group name.');
  return name;
}

export async function getGroup(id: number): Promise<chrome.tabGroups.TabGroup> {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new TabGroupError('tab_group_id_invalid', 'Group IDs must be non-negative integers from group list.');
  }
  try {
    return await chrome.tabGroups.get(id);
  } catch (err) {
    if (err instanceof Error && /No group with id|group no longer exists/i.test(err.message)) {
      throw new TabGroupError('tab_group_not_found', `Group ${id} no longer exists. Run group list and select a live group.`);
    }
    throw err;
  }
}

export async function findGroup(id?: number, name?: string): Promise<chrome.tabGroups.TabGroup> {
  if (id !== undefined) return getGroup(id);
  const title = groupName(name);
  // Chrome's title query is a pattern, not an exact string match.
  const matches = (await chrome.tabGroups.query({})).filter(group => group.title === title);
  if (matches.length > 1) {
    throw new TabGroupError('tab_group_ambiguous', `Several groups are named "${title}". Select one by ID from group list.`);
  }
  if (!matches.length) throw new TabGroupError('tab_group_not_found', `No live group is named "${title}".`);
  return matches[0];
}

export async function describeGroup(group: chrome.tabGroups.TabGroup) {
  const tabs = await chrome.tabs.query({ groupId: group.id });
  return {
    id: group.id,
    title: group.title ?? '',
    color: group.color,
    collapsed: group.collapsed,
    windowId: group.windowId,
    tabs: await Promise.all(tabs.map(async tab => ({
      page: tab.id === undefined ? undefined : await identity.resolveTargetId(tab.id).catch(() => undefined),
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.active ?? false,
    }))),
  };
}

export async function createGroup(name?: string, windowId?: number): Promise<chrome.tabGroups.TabGroup> {
  const title = groupName(name);
  if (windowId !== undefined && (!Number.isSafeInteger(windowId) || windowId < 0)) {
    throw new TabGroupError('tab_group_window_invalid', 'Window IDs must be non-negative integers.');
  }
  // Chrome groups cannot be empty. Always use a new tab, preserving existing content.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true, ...(windowId !== undefined && { windowId }) });
  if (tab.id === undefined) throw new TabGroupError('tab_group_create_failed', 'Chrome did not return a new tab ID.');
  try {
    const id = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(id, { title, collapsed: false });
    return await getGroup(id);
  } catch (err) {
    // Only the tab created by this operation is eligible for rollback.
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
}
