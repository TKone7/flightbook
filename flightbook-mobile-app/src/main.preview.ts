import { Component, importProvidersFrom } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { JsonPipe } from '@angular/common';
import { IonApp, IonContent, provideIonicAngular } from '@ionic/angular/standalone';
import { TranslateLoader, TranslateModule, TranslateService } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { delay, of } from 'rxjs';
import { fromLonLat } from 'ol/proj';
import { PlaceFormComponent } from './app/form/place-form/place-form';
import { FlightFormComponent } from './app/form/flight-form/flight-form';
import { PlaceStore } from './app/place/shared/place.store';
import { ConfigurationService } from './app/shared/services/configuration.service';

/** Separate preview entry point: never imported by the production application. */
@Component({
    selector: 'app-root',
    standalone: true,
    imports: [IonApp, IonContent, PlaceFormComponent, FlightFormComponent, JsonPipe],
    template: `
      <ion-app><ion-content>
        <main>
          <h1>Flightbook form preview</h1>
          <p class="notice">Local sample data. Nothing is saved to the server.
             Elevation/country lookup returns demo values: 900 m, CH.</p>
          <nav>
            <button type="button" (click)="view = 'flight'; saved = null" [class.active]="view === 'flight'">Flight date & duration</button>
            <button type="button" (click)="view = 'place'; saved = null" [class.active]="view === 'place'">Location coordinates</button>
            <button type="button" (click)="language('en')">EN</button>
            <button type="button" (click)="language('de')">DE</button>
          </nav>
          @if (view === 'flight') {
            <flight-form [flight]="flight" [gliders]="gliders" [schools]="[]" [tandemSchools]="[]"
                         (saveFlight)="saved = snapshot($event)"></flight-form>
            <button class="save" type="submit" form="flightForm">Preview save</button>
          } @else {
            <place-form [place]="place" (savePlace)="saved = snapshot($event)"></place-form>
            <button class="save" type="submit" form="placeForm">Preview save</button>
          }
          @if (saved) { <h2>Result (local only)</h2><pre>{{ saved | json }}</pre> }
        </main>
      </ion-content></ion-app>
    `,
    styles: [`
      main { max-width: 700px; padding: 24px 20px 64px; margin: auto; }
      h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 24px; }
      .notice { padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; line-height: 1.5; }
      nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
      button { background: white; border: 1px solid #94a3b8; border-radius: 6px; padding: 10px 14px; color: #172033; cursor: pointer; }
      button.active, button.save { background: #1d4ed8; color: white; border-color: #1d4ed8; }
      button.save { margin-top: 20px; } pre { overflow: auto; padding: 12px; background: #f1f5f9; border-radius: 8px; }
    `]
})
class FormPreviewComponent {
    view = 'flight';
    saved: unknown = null;
    gliders: any[] = [{ id: 1, brand: 'Demo', name: 'Wing', tandem: false }];
    flight: any = {
        date: '2026-10-27', time: '01:30:00', glider: this.gliders[0],
        start: { name: 'Demo takeoff' }, landing: { name: 'Demo landing' },
        km: 8, description: '', tandemSchoolData: { schoolCustomValues: [] }
    };
    place: any = { name: 'Demo location', altitude: 1200, country: 'CH', coordinates: fromLonLat([9.253738, 47.146911]) };
    constructor(private translate: TranslateService) { this.translate.setDefaultLang('en'); this.translate.use('en'); }
    language(value: string) { this.translate.use(value); }
    snapshot(value: unknown) { return JSON.parse(JSON.stringify(value)); }
}

bootstrapApplication(FormPreviewComponent, {
    providers: [
        provideHttpClient(), provideIonicAngular(),
        importProvidersFrom(TranslateModule.forRoot({ loader: {
            provide: TranslateLoader,
            useFactory: (http: HttpClient) => new TranslateHttpLoader(http, './assets/i18n/', '.json'),
            deps: [HttpClient]
        }})),
        { provide: PlaceStore, useValue: {
            getPlacesByName: () => of([]),
            searchOpenstreetmapPlace: () => of({ features: [] }),
            getPlaceMetadata: () => of({ altitude: 900, country: 'CH' }).pipe(delay(250))
        }},
        { provide: ConfigurationService, useValue: { getMapConfiguration: () => of({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attributions: '© OpenStreetMap contributors', crossOrigin: 'anonymous'
        })}}
    ]
}).catch(error => console.error(error));
