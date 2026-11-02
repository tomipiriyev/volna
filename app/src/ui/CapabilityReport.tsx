import type { Capabilities } from '../platform/capabilities';

function Flag({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <span className={`flag ${ok ? 'ok' : 'no'}`}>{ok ? 'yes' : 'no'}</span>
        {detail && <span className="muted"> {detail}</span>}
      </td>
    </tr>
  );
}

const MiB = 1024 * 1024;

export function CapabilityReport({ caps }: { caps: Capabilities | null }) {
  if (!caps) return <p className="muted">Detecting browser capabilities…</p>;
  const gpu = caps.webgpu;
  return (
    <div className="capabilities" data-testid="capabilities">
      <table className="kv">
        <tbody>
          <Flag ok={caps.secureContext} label="Secure context" />
          <Flag ok={caps.crossOriginIsolated} label="Cross-origin isolated" />
          <Flag ok={caps.sharedArrayBuffer} label="SharedArrayBuffer" />
          <Flag
            ok={caps.threads}
            label="Wasm threads"
            detail={caps.threads ? `${caps.hardwareConcurrency} logical cores` : caps.threadsReason}
          />
          <Flag ok={caps.wasm} label="WebAssembly" />
          <Flag ok={caps.wasmSimd} label="Wasm SIMD128" />
          <Flag ok={caps.wasmExceptions} label="Wasm exceptions" />
          {caps.deviceMemoryGB !== undefined && (
            <tr>
              <td>Device memory (reported)</td>
              <td>≥ {caps.deviceMemoryGB} GB</td>
            </tr>
          )}
          <Flag ok={gpu.available} label="WebGPU" detail={gpu.available ? gpu.adapter?.vendor : gpu.reason} />
        </tbody>
      </table>
      {gpu.available && gpu.limits && (
        <details>
          <summary>WebGPU adapter limits</summary>
          <table className="kv small">
            <tbody>
              {gpu.adapter && (
                <tr>
                  <td>Adapter</td>
                  <td>{[gpu.adapter.vendor, gpu.adapter.architecture, gpu.adapter.description].filter(Boolean).join(' · ')}</td>
                </tr>
              )}
              {Object.entries(gpu.limits).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{k.startsWith('maxBuffer') || k.startsWith('maxStorageBufferBinding') ? `${(v / MiB).toFixed(0)} MiB` : v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
