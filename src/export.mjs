// Notes and tasks of a project as one Markdown document (cli export, web download).
const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '');
const STATUS_ORDER = ['doing', 'blocked', 'todo', 'done', 'cancelled'];
const PRIORITY = { 1: 'high', 3: 'low' };

const tagsOf = (t) => { try { return JSON.parse(t || '[]'); } catch { return []; } };
const body = (b) => (b ? `\n${String(b).trim()}\n` : '');

export function itemsMarkdown(project, items) {
  const notes = items.filter((i) => i.kind === 'note').sort((a, b) => b.updated_at - a.updated_at);
  const tasks = items.filter((i) => i.kind === 'task');
  const out = [`# ${project || 'No project'}`, '', `Exported from open-mem on ${day(Date.now())}: ${notes.length} note(s), ${tasks.length} task(s).`];
  if (notes.length) {
    out.push('', '## Notes');
    for (const n of notes) {
      const meta = [`I${n.id}`, `updated ${day(n.updated_at)}`, n.status === 'archived' && 'archived', ...tagsOf(n.tags).map((t) => `#${t}`)].filter(Boolean);
      out.push('', `### ${n.title}`, '', `_${meta.join(' · ')}_`, body(n.body).trimEnd());
    }
  }
  if (tasks.length) {
    out.push('', '## Tasks');
    for (const st of STATUS_ORDER) {
      const group = tasks.filter((t) => t.status === st).sort((a, b) => a.priority - b.priority || b.updated_at - a.updated_at);
      if (!group.length) continue;
      out.push('', `### ${st[0].toUpperCase()}${st.slice(1)}`, '');
      for (const t of group) {
        const meta = [`I${t.id}`, PRIORITY[t.priority] && `${PRIORITY[t.priority]} priority`, t.due_at && `due ${day(t.due_at)}`,
          t.completed_at && `closed ${day(t.completed_at)}`].filter(Boolean).join(' · ');
        out.push(`- [${st === 'done' ? 'x' : ' '}] **${t.title}** (${meta})`);
        if (t.body) out.push(...String(t.body).trim().split('\n').map((l) => `  ${l}`));
      }
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

// A file name for a project that is safe on every system.
export const exportFileName = (project) => `${String(project || 'no-project').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}.md`;
