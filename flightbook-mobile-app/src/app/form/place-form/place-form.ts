import { Component, Input, Output, EventEmitter, OnChanges, ViewChild } from '@angular/core';
import { AlertController, IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/angular/standalone';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { Place } from 'src/app/place/shared/place.model';
import { Countries, Country } from 'src/app/place/shared/place.countries';
import { fromLonLat, toLonLat } from 'ol/proj';
import { parseCoordinatePair } from './coordinate-parser';
import { FormsModule } from '@angular/forms';
import { PlaceMapComponent } from '../../shared/components/place-map/place-map.component';

@Component({
    selector: 'place-form',
    templateUrl: 'place-form.html',
    styleUrls: ['place-form.scss'],
    imports: [FormsModule, PlaceMapComponent, TranslateModule, IonInput, IonSelect, IonSelectOption, IonTextarea]
})
export class PlaceFormComponent implements OnChanges {

    @ViewChild(PlaceMapComponent) private placeMap?: PlaceMapComponent;
    coordinateInput = '';

    ngOnChanges() {
        this.syncCoordinateInputs();
    }

    syncCoordinateInputs() {
        const coordinates = this.place?.coordinates;
        if (!coordinates) {
            this.coordinateInput = '';
            return;
        }
        const [longitude, latitude] = toLonLat(coordinates);
        this.coordinateInput = `${Number(latitude.toFixed(6))}, ${Number(longitude.toFixed(6))}`;
    }

    get coordinatesValid(): boolean {
        return !(this.coordinateInput || '').trim() || parseCoordinatePair(this.coordinateInput) !== null;
    }

    onCoordinateInput() {
        this.placeMap?.cancelCoordinateLookup();
        this.coordinateInput = this.coordinateInput ?? '';
        // Keep incomplete/invalid edits in the field without moving the saved pin.
        if (!this.coordinatesValid) return;
        const lonLat = parseCoordinatePair(this.coordinateInput);
        const position = lonLat ? fromLonLat(lonLat) : undefined;
        this.place.coordinates = position;
        this.placeMap?.setCoordinates(position);
    }

    @Input()
    place: Place;
    @Output()
    savePlace = new EventEmitter<Place>();

    // A copy: sorting and moveCountryToTop mutate in place, and Countries is a
    // shared export that place-list also reads.
    countries: Country[] = [...Countries];
    lang: string;

    constructor(
        private alertController: AlertController,
        private translate: TranslateService
    ) {
        this.lang = this.translate.currentLang;
        this.countries.sort((a, b) => a.name[this.lang].localeCompare(b.name[this.lang]));
        this.moveCountryToTop('de');
        this.moveCountryToTop('fr');
        this.moveCountryToTop('at');
        this.moveCountryToTop('ch');
    }

    async saveElement(loginForm: any) {
        if (loginForm.valid && this.coordinatesValid) {
            await this.placeMap?.finishCoordinateLookup();
            // The form may have changed while a lookup or confirmation was open.
            if (loginForm.valid && this.coordinatesValid) this.savePlace.emit(this.place);
        } else {
            const alert = await this.alertController.create({
                header: this.translate.instant('message.errortitle'),
                message: this.translate.instant(this.coordinatesValid ? 'message.mendatoryFields' : 'place.coordinatesInvalid'),
                buttons: [this.translate.instant('buttons.done')]
            });
            await alert.present();
        }
    }

    clearCountry() {
        this.place.country = null;
    }

    moveCountryToTop(countryCode: string) {
        let index = this.countries.findIndex(country => country.code == countryCode);
        if (index !== -1) {
            let country = this.countries.splice(index, 1)[0];
            this.countries.splice(0, 0, country);
        }
    }

}
