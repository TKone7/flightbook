/** Parse calendar dates without timezone shifts or JavaScript date rollover. */
export function parseFlightDate(input: string): string | null {
    const text = (input || '').trim();
    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const local = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!iso && !local) return null;
    const year = Number(iso ? iso[1] : local![3]);
    const month = Number(iso ? iso[2] : local![2]);
    const day = Number(iso ? iso[3] : local![1]);
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Blank means no duration; bare numbers mean minutes, never decimal hours. */
export function parseFlightDuration(input: string): string | null {
    const text = (input || '').trim();
    if (!text) return '';
    let hours: number, minutes: number, seconds = 0;
    if (/^\d+$/.test(text)) {
        const total = Number(text);
        hours = Math.floor(total / 60); minutes = total % 60;
    } else {
        const match = text.match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/);
        if (!match) return null;
        hours = Number(match[1]); minutes = Number(match[2]); seconds = Number(match[3] || 0);
    }
    // Storage is PostgreSQL time, matching the existing 24-hour duration picker.
    if (!Number.isFinite(hours) || hours > 23) return null;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}
