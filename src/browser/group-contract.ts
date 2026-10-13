/** Wire contract for native Browser Bridge tab-group commands. */
export interface GroupCommandFields {
  groupOp?: 'list' | 'create' | 'use' | 'rename' | 'delete';
  groupId?: number;
  groupName?: string;
  /** Optional destination window for group create. */
  groupWindowId?: number;
}
