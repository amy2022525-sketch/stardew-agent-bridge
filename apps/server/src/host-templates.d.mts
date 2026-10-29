import type {HostId,HostConfigInput,HostConfigSnippet} from './hosts.js';
export declare const HOST_LABELS: Record<HostId,string>;
export declare const HOST_SUPPORT_MATRIX: {host:string;http:string;stdio:string;note:string}[];
export declare function generateHostConfig(input:HostConfigInput):HostConfigSnippet;
