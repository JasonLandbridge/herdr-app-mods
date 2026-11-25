// Keep a space and its linked worktrees together while sorting the sidebar.
// Rows carry the machine in their space, so identical local ids on different
// machines cannot join the same block.
const key = (row, id = row.w?.id) => JSON.stringify([row.w?.machine ?? null, id]);

export function orderBlocks(rows, rootRank) {
  const roots = new Map();
  const blocks = [];

  rows.forEach((row, index) => {
    if (row.under != null) return;
    const block = { index, rank: rootRank(row), rows: [row] };
    blocks.push(block);
    roots.set(key(row), block);
  });

  rows.forEach((row, index) => {
    if (row.under == null) return;
    const block = roots.get(key(row, row.under));
    if (block) block.rows.push(row);
    else blocks.push({ index, rank: rootRank(row), rows: [row] });
  });

  blocks.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return blocks.flatMap((block) => block.rows);
}
