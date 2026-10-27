import { fromLonLat, toLonLat } from 'ol/proj';
import { Subject } from 'rxjs';
import { parseCoordinatePair } from './coordinate-parser';
import { PlaceFormComponent } from './place-form';
import { PlaceMapComponent } from '../../shared/components/place-map/place-map.component';

describe('manual place coordinates', () => {
    it('accepts a pasted latitude, longitude pair with north/east defaults', () => {
        expect(parseCoordinatePair(' 47.146911, 9.253738 ')).toEqual([9.253738, 47.146911]);
        expect(parseCoordinatePair('0, 0')).toEqual([0, 0]);
    });
    it('accepts degrees and decimal minutes with or without hemisphere letters', () => {
        for (const input of ["47° 8.81466′ N, 9° 15.22428′ E", "47°8.81466', 9°15.22428'", 'N 47 8.81466, E 9 15.22428']) {
            const point = parseCoordinatePair(input);
            expect(point).not.toBeNull();
            expect(point![0]).toBeCloseTo(9.253738, 6);
            expect(point![1]).toBeCloseTo(47.146911, 6);
        }
    });
    it('accepts degrees/minutes/seconds and south/west hemispheres', () => {
        const point = parseCoordinatePair('47° 8′ 48.8796″ S, 9° 15′ 13.4568″ W');
        expect(point![0]).toBeCloseTo(-9.253738, 6);
        expect(point![1]).toBeCloseTo(-47.146911, 6);
        expect(parseCoordinatePair('-47.146911, -9.253738')).toEqual([-9.253738, -47.146911]);
        expect(parseCoordinatePair('47.146911 N 9.253738 E')).toEqual([9.253738, 47.146911]);
    });
    it('rejects incomplete, ambiguous, conflicting and out-of-range coordinates', () => {
        for (const input of ['', '47', '47,', '91, 9', '47, 181', '47°60′, 9', '47°8′60″, 9',
            '47.5°8′, 9', '47°8.5′12″, 9', '-47 N, 9 E', '47 E, 9 N', '47,146911, 9,253738',
            '47, 9 trailing text', 'Infinity, 9']) {
            expect(parseCoordinatePair(input)).withContext(input).toBeNull();
        }
        expect(parseCoordinatePair('90°0′0″, 180°0′0″')).toEqual([180, 90]);
        expect(parseCoordinatePair('90°0′1″, 9')).toBeNull();
    });
    function form() {
        const component = new PlaceFormComponent({ create: jasmine.createSpy().and.resolveTo({ present: async () => {} }) } as any,
            { currentLang: 'en', instant: (key: string) => key } as any);
        component.place = { coordinates: fromLonLat([9.253738, 47.146911]), altitude: 1234, country: 'CH' } as any;
        component.ngOnChanges();
        return component;
    }
    it('loads saved coordinates and persists pasted degrees/minutes without changing elevation', async () => {
        const component = form();
        expect(component.coordinateInput).toBe('47.146911, 9.253738');
        component.coordinateInput = '46°30′ N, 8°15′ E';
        component.onCoordinateInput();
        const coordinates = toLonLat(component.place.coordinates);
        expect(coordinates[0]).toBeCloseTo(8.25, 6);
        expect(coordinates[1]).toBeCloseTo(46.5, 6);
        expect(component.place.altitude).toBe(1234);
        expect(component.place.country).toBe('CH');
        const saved = jasmine.createSpy(); component.savePlace.subscribe(saved);
        await component.saveElement({ valid: true });
        expect(saved).toHaveBeenCalledWith(component.place);
    });
    it('blocks invalid input from saving or moving the existing position, and supports clearing', async () => {
        const component = form(); const before = component.place.coordinates;
        const saved = jasmine.createSpy(); component.savePlace.subscribe(saved);
        component.coordinateInput = '47° 99′, 9'; component.onCoordinateInput();
        await component.saveElement({ valid: true });
        expect(saved).not.toHaveBeenCalled();
        expect(component.place.coordinates).toBe(before);
        component.coordinateInput = null as any; component.onCoordinateInput();
        expect(component.coordinatesValid).toBeTrue();
        expect(component.place.coordinates).toBeUndefined();
    });
    it('does not let an in-flight name search replace manually pasted coordinates', async () => {
        const lookup = new Subject<any>();
        const component = new PlaceMapComponent({ searchOpenstreetmapPlace: () => lookup } as any,
            {} as any, {} as any, {} as any, { run: (fn: any) => fn() } as any);
        component.place = {} as any;
        const view = { setCenter: jasmine.createSpy(), setZoom: jasmine.createSpy() };
        (component as any).map = { getView: () => view };
        const pending = (component as any).searchPlace('Test');
        const manual = fromLonLat([9.253738, 47.146911]);
        component.setCoordinates(manual);
        lookup.next({ features: [{ geometry: { coordinates: [8, 46] } }] }); lookup.complete();
        await pending;
        expect(component.place.coordinates).toBe(manual);
        expect(view.setCenter).toHaveBeenCalledOnceWith(manual);
        expect((component as any).marker.getGeometry().getCoordinates()).toEqual(manual);
    });
});
