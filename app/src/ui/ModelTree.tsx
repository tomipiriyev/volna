import { useState } from 'react';
import { useProject, useUi } from '../model/store';
import type { CadModel, CadNode } from '../model/types';
import { ROLE_HEX, ROLE_LABEL } from '../viewport/style';

function BodyRow({ model, id, depth }: { model: CadModel; id: string; depth: number }) {
  const body = model.bodies.find((b) => b.id === id)!;
  const role = useProject((s) => s.assignments[id]?.role);
  const selection = useUi((s) => s.selection);
  const hidden = useUi((s) => s.hidden.has(id));
  const isolated = useUi((s) => s.isolated);
  const [open, setOpen] = useState(false);
  const selected = selection.bodyId === id;
  return (
    <li>
      <div className={`tree-row body${selected && selection.faceIndex === null ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 12 }}>
        <button type="button" className="twisty" onClick={() => setOpen(!open)} aria-label={open ? 'Hide faces' : 'Show faces'} data-testid={`tree-expand-${body.name}`}>
          {open ? '▾' : '▸'}
        </button>
        <button type="button" className="tree-label" onClick={() => useUi.getState().select(id)} data-testid={`tree-body-${body.name}`}>
          <span className="role-dot" style={{ background: role ? ROLE_HEX[role] : 'transparent' }} title={role ? ROLE_LABEL[role] : 'Unassigned'} />
          {body.name}
        </button>
        <button
          type="button"
          className={`icon${isolated === id ? ' on' : ''}`}
          title={isolated === id ? 'Show all' : 'Isolate'}
          onClick={() => useUi.getState().setIsolated(isolated === id ? null : id)}
        >
          ◎
        </button>
        <button type="button" className={`icon${hidden ? '' : ' on'}`} title={hidden ? 'Show' : 'Hide'} onClick={() => useUi.getState().toggleHidden(id)}>
          {hidden ? '○' : '●'}
        </button>
      </div>
      {open && (
        <ul>
          {body.faces.map((f) => (
            <li key={f.index}>
              <button
                type="button"
                className={`tree-row face${selected && selection.faceIndex === f.index ? ' selected' : ''}`}
                style={{ paddingLeft: 28 + depth * 12 }}
                onClick={() => useUi.getState().select(id, f.index)}
                data-testid={`tree-face-${body.name}-${f.index + 1}`}
              >
                Face {f.index + 1}
                <span className="muted"> {f.planar ? (f.axisAligned !== null ? `plane ⟂${'xyz'[f.axisAligned]}` : 'plane') : 'curved'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function NodeRow({ model, node, depth }: { model: CadModel; node: CadNode; depth: number }) {
  // A part node holding one body of the same name is shown as just the body.
  const single = node.children.length === 0 && node.bodyIds.length === 1 && model.bodies.find((b) => b.id === node.bodyIds[0])?.name === node.name;
  const named = node.name !== '' && !single;
  const inner = (
    <>
      {node.bodyIds.map((id) => (
        <BodyRow key={id} model={model} id={id} depth={named ? depth + 1 : depth} />
      ))}
      {node.children.map((c, i) => (
        <NodeRow key={i} model={model} node={c} depth={named ? depth + 1 : depth} />
      ))}
    </>
  );
  if (!named) return inner;
  return (
    <li>
      <div className="tree-row node" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="muted">▣</span> {node.name}
      </div>
      <ul>{inner}</ul>
    </li>
  );
}

export function ModelTree() {
  const model = useProject((s) => s.model);
  if (!model) return <p className="muted placeholder">No model loaded.</p>;
  return (
    <div className="tree" data-testid="model-tree">
      <p className="muted small">
        {model.fileName} · {model.bodies.length} bodies
      </p>
      <ul>
        <NodeRow model={model} node={model.root} depth={0} />
      </ul>
    </div>
  );
}
