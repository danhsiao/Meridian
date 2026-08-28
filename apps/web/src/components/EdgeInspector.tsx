"use client";

// Selecting a connection.
//
// Deleting an edge is about as common as drawing one, and neither had a
// control. What's editable here depends on what the compiler makes of the
// edge's endpoints — the same derivation the IR uses, so the panel can never
// offer a key that codegen wouldn't read.

import type { Board, Edge } from "@engine/compiler/client";
import { registry } from "@engine/compiler/client";

export default function EdgeInspector({
  edge,
  board,
  pending,
  onSet,
  onDelete,
  onClose,
}: {
  edge: Edge;
  board: Board;
  pending: boolean;
  onSet: (key: string, value: unknown) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const from = board.nodes.find((n) => n.id === edge.from);
  const to = board.nodes.find((n) => n.id === edge.to);
  if (!from || !to) return null;

  const enums = (registry.kinds.edge?.enums ?? {}) as Record<string, unknown[]>;
  // Wording comes from the registry, so the inspector and the review agent
  // cannot call the same value two different things.
  // Same templates the review agent uses, filled with the same two labels —
  // so the inspector and a comment can never describe an edge differently.
  const say = (key: string) => {
    const raw = registry.ask[`edge.${key}`]?.option_labels ?? {};
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        v.replaceAll("{from}", from.label).replaceAll("{to}", to.label),
      ]),
    );
  };
  const bothArtifacts = from.primitive === "artifact" && to.primitive === "artifact";
  const isFail = from.primitive === "policy" && to.primitive === "channel";
  // A record-carrying edge is the only place "one or many" means anything.
  const carriesRecords = to.primitive === "artifact";

  const sharedFields = fieldsOf(from).filter((f) => fieldsOf(to).includes(f));

  return (
    <aside className="panel inspector">
      <div className="panel-head">
        <h2>Connection</h2>
        <button className="close" onClick={onClose}>×</button>
      </div>

      <div className="inspector-body">
        <p className="lede">
          <strong>{from.label}</strong> → <strong>{to.label}</strong>
        </p>

        {bothArtifacts && (
          <Field label="How they relate">
            <Picker
              value={edge.config.rel as string}
              options={(enums.rel ?? []) as string[]}
              labels={say("rel")}
              disabled={pending}
              onPick={(v) => onSet("rel", v)}
            />
          </Field>
        )}

        {bothArtifacts && edge.config.rel === "pairs_with" && (
          <Field label="Matched on">
            {sharedFields.length > 0 ? (
              <Picker
                value={edge.config.on as string}
                options={sharedFields}
                disabled={pending}
                onPick={(v) => onSet("on", v)}
              />
            ) : (
              <p className="note">
                These don't have a value in common yet. Add a matching field to
                both, or pick a different relationship.
              </p>
            )}
          </Field>
        )}

        {carriesRecords && (
          <Field label="How many come through">
            <Picker
              value={(edge.config.cardinality as string) ?? "one"}
              options={(enums.cardinality ?? []) as string[]}
              labels={say("cardinality")}
              disabled={pending}
              onPick={(v) => onSet("cardinality", v)}
            />
          </Field>
        )}

        {isFail && (
          <>
            <p className="note">
              This runs when the check fails. The run pauses here and picks back
              up when a reply arrives, re-checking only what failed.
            </p>
            <Field label="How long to wait">
              <Picker
                value={edge.config.timeout as string}
                options={(enums.timeout ?? []) as string[]}
                labels={say("timeout")}
                disabled={pending}
                onPick={(v) => onSet("timeout", v)}
              />
            </Field>
            <Field label="How many times to chase">
              <Picker
                value={String(edge.config.max_attempts ?? 1)}
                options={((enums.max_attempts ?? []) as number[]).map(String)}
                disabled={pending}
                onPick={(v) => onSet("max_attempts", Number(v))}
              />
            </Field>
            <Field label="If nobody replies">
              <Picker
                value={edge.config.on_exhausted as string}
                options={(enums.on_exhausted ?? []) as string[]}
                labels={say("on_exhausted")}
                disabled={pending}
                onPick={(v) => onSet("on_exhausted", v)}
              />
            </Field>
          </>
        )}

        <button className="danger" disabled={pending} onClick={onDelete}>
          Delete this connection
        </button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ifield">
      <div className="ilabel">{label}</div>
      {children}
    </div>
  );
}

function Picker({
  value, options, labels, disabled, onPick,
}: {
  value: string | undefined;
  options: string[];
  labels?: Record<string, string>;
  disabled: boolean;
  onPick: (v: string) => void;
}) {
  return (
    <div className="choices">
      {options.map((o) => (
        <button
          key={o}
          className={`choice ${value === o ? "picked" : ""}`}
          disabled={disabled}
          onClick={() => onPick(o)}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

function fieldsOf(n: { config: Record<string, unknown> }): string[] {
  return Array.isArray(n.config?.fields) ? (n.config.fields as string[]) : [];
}
