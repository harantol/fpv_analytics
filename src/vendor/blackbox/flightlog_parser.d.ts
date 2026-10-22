/** Types minimaux du parseur Blackbox de Betaflight (module JS copié tel quel). */
export interface FrameDef {
  name: string[];
  count: number;
}

export declare class FlightLogParser {
  constructor(logData: Uint8Array);
  frameDefs: Partial<Record<'I' | 'P' | 'G' | 'H' | 'S', FrameDef>>;
  sysConfig: Record<string, unknown> & { firmwareType: number; firmwareVersion: string };
  onFrameReady: ((valid: boolean, frame: number[] | unknown, frameType: string, offset: number, size: number) => void) | null;
  parseHeader(startOffset?: number, endOffset?: number): void;
  parseLogData(raw: boolean, startOffset?: number, endOffset?: number): void;
  resetDataState(): void;
}
