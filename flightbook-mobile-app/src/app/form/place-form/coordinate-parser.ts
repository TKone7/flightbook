/** Parse latitude first, longitude second; store longitude first for OpenLayers. */
export function parseCoordinatePair(input: string): [number, number] | null {
    const text = input.trim();
    let parts = text.split(/[,;]/);
    if (parts.length === 1) {
        // Hemisphere letters delimit coordinates copied without a comma.
        const hemispheres = text.match(/^(.+?[NS])\s+(.+[EW])$/i)
            || text.match(/^([NS].+?)\s+([EW].+)$/i);
        const decimals = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
        const match = hemispheres || decimals;
        if (!match) return null;
        parts = [match[1], match[2]];
    }
    if (parts.length !== 2) return null;
    const latitude = parseAngle(parts[0], true);
    const longitude = parseAngle(parts[1], false);
    return latitude === null || longitude === null ? null : [longitude, latitude];
}

function parseAngle(input: string, latitude: boolean): number | null {
    let text = input.trim().toUpperCase();
    const leading = text.match(/^([NSEW])\s*/);
    const trailing = text.match(/\s*([NSEW])$/);
    if (leading && trailing) return null;
    const hemisphere = leading?.[1] || trailing?.[1];
    if (hemisphere && !(latitude ? /^[NS]$/ : /^[EW]$/).test(hemisphere)) return null;
    if (leading) text = text.slice(leading[0].length);
    if (trailing) text = text.slice(0, -trailing[0].length);
    // Accept ASCII and typographic degree/minute/second marks.
    const parts = text.replace(/[°º'′’"″]/g, ' ').trim().split(/\s+/);
    if (parts.length < 1 || parts.length > 3
        || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(parts[0])
        || parts.slice(1).some(part => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(part))) return null;
    const degrees = Number(parts[0]);
    const minutes = Number(parts[1] || 0);
    const seconds = Number(parts[2] || 0);
    if (![degrees, minutes, seconds].every(Number.isFinite)
        || (parts.length > 1 && !Number.isInteger(degrees))
        || (parts.length > 2 && !Number.isInteger(minutes))
        || minutes >= 60 || seconds >= 60) return null;
    const negative = parts[0].startsWith('-');
    if (negative && (hemisphere === 'N' || hemisphere === 'E')) return null;
    const sign = hemisphere === 'S' || hemisphere === 'W' || negative ? -1 : 1;
    const value = sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
    return Math.abs(value) <= (latitude ? 90 : 180) ? value : null;
}
