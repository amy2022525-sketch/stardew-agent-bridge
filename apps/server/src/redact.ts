import { redactPath, type DataPaths } from './paths.js';

/** Redact nested diagnostic payloads before previewing or writing them. */
export function redactDiagnostics(value: unknown, paths: DataPaths): unknown {
    if (typeof value === 'string') return redactPath(value, paths)
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
        .replace(/\b[a-f0-9]{32,128}\b/gi, '<redacted>')
        .replace(/[A-Za-z]:[\\/][^\s"<>]*/g, '<path>')
        .replace(/\b[A-Za-z][A-Za-z0-9]*_\d{9,}\b/g, '<save>');
    if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, paths));
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key,
            /token|secret|password|authorization|^saveId$/i.test(key) ? '<redacted>' : redactDiagnostics(item, paths)])
    );
    return value;
}
