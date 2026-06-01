import type { DiffOp } from '@secretary/shared-types';

const LINE: Record<DiffOp['op'], string> = {
  eq: 'text-slate-600',
  add: 'bg-green-50 text-green-700',
  del: 'bg-red-50 text-red-700 line-through',
};

export function DiffView({ ops }: { ops: DiffOp[] }): JSX.Element {
  return (
    <pre className="overflow-auto rounded-lg border border-slate-200 p-2 text-xs leading-relaxed">
      {ops.map((op, i) => (
        <div key={i} className={LINE[op.op]}>
          {op.op === 'add' ? '+ ' : op.op === 'del' ? '- ' : '  '}
          <span>{op.line || ' '}</span>
        </div>
      ))}
    </pre>
  );
}
