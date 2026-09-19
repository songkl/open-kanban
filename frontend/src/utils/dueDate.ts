export type DueDateMeta = {
  state: 'overdue' | 'today' | 'soon' | 'future' | 'none';
  daysRemaining: number;
  label: string;
};

export function getDueDateMeta(iso: string): DueDateMeta {
  const due = new Date(iso);
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  let state: DueDateMeta['state'] = 'future';
  if (diffDays < 0) state = 'overdue';
  else if (diffDays === 0) state = 'today';
  else if (diffDays <= 3) state = 'soon';
  return {
    state,
    daysRemaining: diffDays,
    label: due.toLocaleDateString(),
  };
}
