/** 内部小工具：游戏日期比较（供 completion/world-scope 复用，避免循环依赖）。 */
export interface GameDateLike { season: string; day: number; year: number }
export interface TileStamp { season: string; day: number; year: number }

export interface TileWaterStamp {
    watered: boolean;
    hasCrop: boolean;
    observedAtMs: number;
    season: string;
    day: number;
    year: number;
}

export function compareGameDates(tile: TileStamp, date: GameDateLike | null | undefined): "same" | "different" | "unknown" {
    if (!date) return "unknown";
    return tile.season === date.season && tile.day === date.day && tile.year === date.year ? "same" : "different";
}
