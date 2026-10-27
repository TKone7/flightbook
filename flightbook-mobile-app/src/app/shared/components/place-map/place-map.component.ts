import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, NgZone, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import { TranslateService } from '@ngx-translate/core';
import { Point as GeoPoint, Position } from 'geojson';
import { Feature, View } from 'ol';
import Map from 'ol/Map';
import Attribution from 'ol/control/Attribution';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import { fromLonLat, toLonLat } from 'ol/proj';
import OSM from 'ol/source/OSM';
import VectorSource from 'ol/source/Vector';
import { firstValueFrom } from 'rxjs';
import { Place } from 'src/app/place/shared/place.model';
import { PlaceStore } from 'src/app/place/shared/place.store';
import { ConfigurationService } from '../../services/configuration.service';
import { createMarkerStyle } from './place-marker.style';

/**
 * Where the map starts for a place that has no coordinates yet.
 *
 * The previous default was zoom 1 on [0, 0]: the whole globe, centred in the
 * Gulf of Guinea, leaving the pilot to find the Alps before they could place
 * anything.
 *
 * Fractional on purpose. Switzerland is about 348km east to west, and at this
 * latitude an integer zoom of 7 spans only 314km on a 375px phone - clipping
 * Geneva and the eastern Grisons, the two ends you would zoom out to find. 6.7
 * spans 387km wide and 289km down the map's 280px height, so the whole country
 * fits with a margin on every phone size.
 */
const DEFAULT_CENTER_LON_LAT = [8.23, 46.8];
const DEFAULT_ZOOM = 6.7;

@Component({
    selector: 'fb-place-map',
    templateUrl: './place-map.component.html',
    styleUrls: ['./place-map.component.scss'],
    standalone: true,
})
export class PlaceMapComponent implements AfterViewInit, OnChanges, OnDestroy {

    @ViewChild('mapContainer', { static: true }) private mapContainer: ElementRef<HTMLDivElement>;

    private map: Map;
    private vectorSource = new VectorSource();
    private vectorLayer: VectorLayer<any>;

    private marker = new Feature();

    private timerId: NodeJS.Timeout;

    /** True while the pin is the name lookup's guess rather than a real choice. */
    private coordinatesFromSearch = false;
    private lookupGeneration = 0;
    private metadataTimer?: ReturnType<typeof setTimeout>;
    private pendingMetadata?: () => Promise<void>;
    private metadataRequest?: Promise<void>;
    /**
     * What this component last wrote into altitude and country. Compared against
     * the field rather than tracked as a "we filled this once" flag: that flag
     * never went back to false, so once the pilot corrected an auto-filled
     * altitude the next rename claimed the corrected value as ours and
     * overwrote it. A value still equal to the guess is ours to refine; the
     * moment it differs, it is the pilot's to keep.
     */
    private guessedAltitude?: number;
    private guessedCountry?: string;

    @Input()
    placeName: String;

    @Input()
    place: Place;

    @Output() coordinatesChange = new EventEmitter<Position>();

    /** A typed position is an explicit choice, so pending name searches cannot replace it. */
    setCoordinates(position?: Position) {
        clearTimeout(this.timerId);
        this.cancelCoordinateLookup();
        this.coordinatesFromSearch = false;
        this.place.coordinates = position;
        this.marker.setGeometry(position ? new Point(position) : undefined);
        if (position && this.map) {
            this.map.getView().setCenter(position);
            this.map.getView().setZoom(15);
        }
        if (position) {
            const generation = this.lookupGeneration;
            this.pendingMetadata = () => this.updatePositionMetadata(position, generation);
            // Typing a pair can produce several valid intermediate positions.
            this.metadataTimer = setTimeout(() => void this.finishCoordinateLookup(), 600);
        }
    }

    cancelCoordinateLookup() {
        clearTimeout(this.metadataTimer);
        this.pendingMetadata = undefined;
        this.metadataRequest = undefined;
        this.lookupGeneration++;
    }

    /** Save flushes the debounce and waits for any lookup/overwrite confirmation. */
    async finishCoordinateLookup(): Promise<void> {
        clearTimeout(this.metadataTimer);
        const pending = this.pendingMetadata;
        this.pendingMetadata = undefined;
        if (pending) this.metadataRequest = pending();
        await this.metadataRequest;
    }

    constructor(
        private placeStore: PlaceStore,
        private alertController: AlertController,
        private translate: TranslateService,
        private configurationService: ConfigurationService,
        private zone: NgZone
    ) {
        this.vectorSource.addFeature(this.marker);

        this.vectorLayer = new VectorLayer({
            source: this.vectorSource,
            style: createMarkerStyle()
        });
    }

    ngOnChanges(changes: SimpleChanges): void {
        // Only placeName drives the lookup; a `place`-only change used to throw
        // here because changes.placeName was dereferenced unconditionally.
        const placeName = changes.placeName;
        if (!placeName) {
            return;
        }

        // Never on the first change: that one is the place arriving from the
        // store, and re-geocoding a place the pilot already saved replaced
        // their surveyed altitude and country with an OSM guess a second after
        // the form opened - silently, and then on Save. `new Place()` has no
        // name, so the add form loses nothing.
        if (placeName.firstChange) {
            return;
        }

        // A pin the lookup placed may follow further typing; one the pilot placed,
        // or one loaded with an existing place, must not be moved by a rename.
        const ownsPin = !this.place?.coordinates || this.coordinatesFromSearch;
        if (ownsPin && placeName.currentValue && placeName.currentValue != "") {
            clearTimeout(this.timerId);
            this.timerId = setTimeout(() => this.searchPlace(placeName.currentValue), 1000);
        }
    }

    private destroyed = false;

    ngAfterViewInit() {
        this.initMap(this.place.coordinates);
    }

    /**
     * Same teardown the IGC map got: an OpenLayers Map holds its target and its
     * tile sources until disposed, and the debounced lookup can still fire a
     * second after the form closed.
     */
    ngOnDestroy() {
        this.destroyed = true;
        this.cancelCoordinateLookup();
        clearTimeout(this.timerId);
        this.map?.setTarget(undefined);
        this.map?.dispose();
    }

    private async searchPlace(name: string) {
        const generation = this.lookupGeneration;
        const res = await firstValueFrom(this.placeStore.searchOpenstreetmapPlace(name));
        if (this.destroyed || generation !== this.lookupGeneration || !this.map || (this.place.coordinates && !this.coordinatesFromSearch) || !res.features || res.features.length === 0) {
            return;
        }
        const geometry = res.features[0]?.geometry as GeoPoint
        const position = fromLonLat(geometry.coordinates);

        // Centring alone left the map looking unset: mark the hit, and keep it
        // as the place's position so saving stores what is on screen.
        this.marker.setGeometry(new Point(position));
        this.place.coordinates = position;
        this.coordinatesFromSearch = true;
        this.zone.run(() => this.coordinatesChange.emit(position));

        this.map.getView().setCenter(position);
        this.map.getView().setZoom(14);

        await this.applySearchMetadata(geometry.coordinates);
    }

    /**
     * Altitude and country for a pin the lookup placed, so a place created by
     * name alone saves with the same fields a double-tapped one does.
     *
     * Silent, unlike the double-tap path: this runs off the debounced rename,
     * and the only values it can overwrite are an earlier guess of its own -
     * ngOnChanges will not call us once the pilot has placed the pin themselves.
     * The metadata lookup is best-effort; losing it must not undo the position.
     */
    private async applySearchMetadata(lonLat: Position) {
        try {
            const metadata = await firstValueFrom(this.placeStore.getPlaceMetadata(lonLat));
            if (this.destroyed || !this.coordinatesFromSearch) {
                return;
            }
            this.zone.run(() => {
                // Fill an empty field, or refine an earlier guess of our own -
                // but never replace a value the pilot entered. An existing
                // place reaches here by being renamed, and its altitude may
                // have been surveyed rather than looked up.
                if (this.ownsAltitude()) {
                    this.place.altitude = metadata.altitude;
                    this.guessedAltitude = metadata.altitude;
                }
                if (this.ownsCountry()) {
                    this.place.country = metadata.country;
                    this.guessedCountry = metadata.country;
                }
            });
        } catch {
            // Keep the coordinates; the pilot can still fill these in by hand.
        }
    }

    /**
     * Empty counts as ours - there is nothing to lose by filling it. An
     * ion-input can hand the value back as a string, which fails the identity
     * check and so errs towards leaving it alone: the safe direction.
     */
    private ownsAltitude(): boolean {
        return this.place.altitude == null || this.place.altitude === this.guessedAltitude;
    }

    private ownsCountry(): boolean {
        return !this.place.country || this.place.country === this.guessedCountry;
    }

    /**
     * The deliberate double-tap path, which replaces both fields together.
     * Recording what it wrote is what lets a second double-tap tell its own
     * guess from a surveyed value and skip the confirm only for the former.
     */
    private writeMetadata(metadata: Place) {
        this.place.altitude = metadata.altitude;
        this.guessedAltitude = metadata.altitude;
        this.place.country = metadata.country;
        this.guessedCountry = metadata.country;
    }

    private async initMap(position?: Position) {
        const config = await firstValueFrom(this.configurationService.getMapConfiguration());
        // The configuration is an HTTP call: leaving the form before it returns
        // would otherwise build a Map against a detached element that
        // ngOnDestroy has already run past, so nothing ever disposes it.
        if (this.destroyed) {
            return;
        }
        // The user may type coordinates while map configuration is loading.
        position = this.place.coordinates;
        const attributionControl = new Attribution({
            collapsible: true,
            collapsed: true
        })

        let zoom = DEFAULT_ZOOM;
        let mapPoition = fromLonLat(DEFAULT_CENTER_LON_LAT);

        if (position && position != null) {
            this.marker.setGeometry(new Point(position));
            zoom = 15;
            mapPoition = position;
        }

        this.map = new Map({
            layers: [
                new TileLayer({
                    source: new OSM({
                        url: config.url,
                        attributions: config.attributions,
                        crossOrigin: config.crossOrigin
                    })
                }),
                this.vectorLayer
            ],
            controls: [attributionControl],
            target: this.mapContainer.nativeElement,
            view: new View({
                center: mapPoition,
                zoom: zoom,
            }),
        });

        this.map.on('dblclick', this.onDblclick)
    }

    onDblclick = (async (evt: any) => {
        clearTimeout(this.timerId);
        this.cancelCoordinateLookup();
        this.coordinatesFromSearch = false;
        this.zone.run(() => {
            this.place.coordinates = evt.coordinate;
            this.coordinatesChange.emit(evt.coordinate);
        });
        this.marker.setGeometry(new Point(evt.coordinate));
        await this.updatePositionMetadata(evt.coordinate, this.lookupGeneration);
    });

    /** Both typed coordinates and map selections use the same replacement rules. */
    private async updatePositionMetadata(position: Position, generation: number) {
        const current = () => !this.destroyed && generation === this.lookupGeneration;
        try {
            const metadata = await firstValueFrom(this.placeStore.getPlaceMetadata(toLonLat(position)));
            if (!current()) return;
            // A country-only correction and an elevation of zero also belong to the user.
            if (!this.ownsAltitude() || !this.ownsCountry()) {
                const alert = await this.alertController.create({
                    header: this.translate.instant('message.infotitle'),
                    message: this.translate.instant('place.override'),
                    buttons: [
                        {
                            text: this.translate.instant('buttons.yes'),
                            handler: () => {
                                if (current()) this.zone.run(() => this.writeMetadata(metadata));
                            }
                        },
                        this.translate.instant('buttons.no')
                    ]
                });
                if (!current()) return;
                await alert.present();
                await alert.onDidDismiss();
            } else {
                this.zone.run(() => this.writeMetadata(metadata));
            }
        } catch {
            // A failed lookup must preserve the chosen position and manual metadata.
        }
    }
}
