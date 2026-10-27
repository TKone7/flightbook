import { parseFlightDate, parseFlightDuration } from './flight-input';
import { FlightFormComponent } from './flight-form';

describe('desktop flight date and duration entry', () => {
    it('accepts local and ISO dates without timezone conversion', () => {
        expect(parseFlightDate('27.10.2026')).toBe('2026-10-27');
        expect(parseFlightDate(' 2026-10-27 ')).toBe('2026-10-27');
        expect(parseFlightDate('1.2.2026')).toBe('2026-02-01');
        expect(parseFlightDate('29.2.2024')).toBe('2024-02-29');
    });
    it('rejects impossible and ambiguous dates instead of rolling them over', () => {
        for (const date of ['', '31.4.2026', '29.2.2026', '2026-13-01', '10/11/26', '2026-00-01']) {
            expect(parseFlightDate(date)).withContext(date).toBeNull();
        }
    });
    it('accepts hours:minutes or whole minutes, preserving optional seconds', () => {
        expect(parseFlightDuration('1:30')).toBe('01:30:00');
        expect(parseFlightDuration('90')).toBe('01:30:00');
        expect(parseFlightDuration('5')).toBe('00:05:00');
        expect(parseFlightDuration('0')).toBe('00:00:00');
        expect(parseFlightDuration('01:30:45')).toBe('01:30:45');
        expect(parseFlightDuration('')).toBe('');
        expect(parseFlightDuration(null as any)).toBe('');
    });
    it('rejects invalid minutes and durations the existing database cannot store', () => {
        for (const duration of ['1:60', '-30', '1.5', '24:00', '1440', '1:30:60', 'abc']) {
            expect(parseFlightDuration(duration)).withContext(duration).toBeNull();
        }
    });
    function setup() {
        const create = jasmine.createSpy().and.resolveTo({ present: async () => {} });
        const form = new FlightFormComponent({ create } as any, { currentLang: 'en', instant: (key: string) => key } as any);
        form.desktopInputs = true;
        form.flight = { date: '2026-10-27', time: '01:30:00' } as any;
        form.ngDoCheck();
        return { form, create };
    }
    it('loads existing values and follows an IGC import that updates the same flight object', () => {
        const { form } = setup();
        expect(form.dateInput).toBe('27.10.2026'); expect(form.durationInput).toBe('01:30');
        form.flight.date = '2026-09-05'; form.flight.time = '00:42:35'; form.ngDoCheck();
        expect(form.dateInput).toBe('05.09.2026'); expect(form.durationInput).toBe('00:42:35');
    });
    it('saves normalized values and allows the duration to be cleared', async () => {
        const { form } = setup(); const saved = jasmine.createSpy(); form.saveFlight.subscribe(saved);
        form.dateInput = '1.2.2026'; form.onDateInput();
        form.durationInput = '90'; form.onDurationInput();
        await form.submitForm({ valid: true } as any);
        expect(saved).toHaveBeenCalledWith(jasmine.objectContaining({ date: '2026-02-01', time: '01:30:00' }));
        form.durationInput = ''; form.onDurationInput();
        expect(form.flight.time).toBeNull();
    });
    it('retains an unfinished keyboard edit and blocks invalid values from saving', async () => {
        const { form, create } = setup(); const saved = jasmine.createSpy(); form.saveFlight.subscribe(saved);
        form.dateInput = '31.2.2026'; form.onDateInput(); form.ngDoCheck();
        expect(form.dateInput).toBe('31.2.2026'); expect(form.flight.date).toBe('2026-10-27');
        await form.submitForm({ valid: true } as any);
        expect(saved).not.toHaveBeenCalled(); expect(create).toHaveBeenCalled();
        form.dateInput = '27.10.2026'; form.onDateInput();
        form.durationInput = '1:99'; form.onDurationInput();
        await form.submitForm({ valid: true } as any);
        expect(saved).not.toHaveBeenCalled(); expect(form.flight.time).toBe('01:30:00');
    });
});
