/**
 * Docker 模式 Web 展示逻辑的类型声明（实现在同目录 docker-status.mjs）。
 * 纯函数：供 main.ts 装配与 tests/src/docker-web.test.ts 直接导入测试。
 */
export interface DockerStatusView {
    schemaVersion: 1;
    mode: 'bridge' | 'game';
    state: string;
    live: boolean;
    modConnected: boolean;
    saveLoaded: boolean;
    desktopEnabled: boolean;
    desktopAvailable: boolean;
    reasonCode: string;
    desktopBaseUrl: string | null;
}
export declare function parseDockerStatus(raw: unknown): DockerStatusView | null;
export declare function fetchDockerStatus(fetchImpl?: typeof fetch): Promise<DockerStatusView | null>;
export declare function desktopLinkUrl(status: DockerStatusView | null): string | null;
export declare function dockerStatusHint(status: DockerStatusView | null): { title: string; detail: string } | null;
