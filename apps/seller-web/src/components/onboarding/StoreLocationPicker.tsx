import React, { useMemo, useState } from 'react';
import { computeApproximateDistanceMeters } from '../../utils/onboardingConstants';

export interface StoreLocationPickerProps {
  address: string;
  pincode: string;
  latitude: string;
  longitude: string;
  gpsAccuracyMeters: string;
  gpsCapturedAt: string | null;
  disabled: boolean;
  hasApprovedLocationHistory: boolean;
  approvedAddress?: string | null;
  approvedPincode?: string | null;
  approvedLatitude?: number | null;
  approvedLongitude?: number | null;
  reverificationRequired: boolean;
  reverificationReason: string | null;
  onChangeAddress: (val: string) => void;
  onChangePincode: (val: string) => void;
  onChangeLatitude: (val: string) => void;
  onChangeLongitude: (val: string) => void;
  onChangeGpsAccuracy: (val: string) => void;
}

export const StoreLocationPicker: React.FC<StoreLocationPickerProps> = ({
  address,
  pincode,
  latitude,
  longitude,
  gpsAccuracyMeters,
  gpsCapturedAt,
  disabled,
  hasApprovedLocationHistory,
  approvedAddress,
  approvedPincode,
  approvedLatitude,
  approvedLongitude,
  reverificationRequired,
  reverificationReason,
  onChangeAddress,
  onChangePincode,
  onChangeLatitude,
  onChangeLongitude,
  onChangeGpsAccuracy
}) => {
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoSuccess, setGeoSuccess] = useState<string | null>(null);

  const parsedLat = Number(latitude);
  const parsedLng = Number(longitude);
  const hasValidCoords =
    latitude.trim().length > 0 &&
    longitude.trim().length > 0 &&
    Number.isFinite(parsedLat) &&
    Number.isFinite(parsedLng) &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    parsedLng >= -180 &&
    parsedLng <= 180 &&
    !(parsedLat === 0 && parsedLng === 0);

  const locationChangeWarning = useMemo(() => {
    if (!hasApprovedLocationHistory) return null;
    if (
      typeof approvedAddress === 'string' &&
      approvedAddress.trim() &&
      address.trim() &&
      address.trim().toLowerCase() !== approvedAddress.trim().toLowerCase()
    ) {
      return 'Changing the verified physical shop street address on an approved store triggers mandatory Admin location re-verification.';
    }
    if (
      typeof approvedPincode === 'string' &&
      approvedPincode.trim() &&
      pincode.trim() &&
      pincode.trim() !== approvedPincode.trim()
    ) {
      return 'Changing the verified shop pincode triggers mandatory Admin location re-verification.';
    }
    if (
      hasValidCoords &&
      typeof approvedLatitude === 'number' &&
      typeof approvedLongitude === 'number' &&
      Number.isFinite(approvedLatitude) &&
      Number.isFinite(approvedLongitude)
    ) {
      const dist = computeApproximateDistanceMeters(
        approvedLatitude,
        approvedLongitude,
        parsedLat,
        parsedLng
      );
      if (dist > 100) {
        return `Selected GPS pin is approximately ${Math.round(dist)}m from your approved shop coordinates (threshold: 100m). Saving will move the store into Re-verification Required status until Admin re-approval.`;
      }
    }
    return null;
  }, [
    hasApprovedLocationHistory,
    approvedAddress,
    approvedPincode,
    approvedLatitude,
    approvedLongitude,
    address,
    pincode,
    hasValidCoords,
    parsedLat,
    parsedLng
  ]);

  const handleCaptureBrowserGps = () => {
    if (disabled) return;
    setGeoError(null);
    setGeoSuccess(null);

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError(
        'Browser geolocation is unavailable in this environment. Enter exact shop GPS latitude and longitude manually below.'
      );
      return;
    }

    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude.toFixed(6);
        const lng = position.coords.longitude.toFixed(6);
        const acc = Number.isFinite(position.coords.accuracy)
          ? String(Math.round(position.coords.accuracy))
          : '15';
        onChangeLatitude(lat);
        onChangeLongitude(lng);
        onChangeGpsAccuracy(acc);
        setGeoSuccess(`Device GPS captured (${lat}, ${lng}, accuracy ~${acc}m). Remember to Save Draft Profile.`);
        setGeoLoading(false);
      },
      (err) => {
        setGeoError(
          err?.message
            ? `Unable to capture GPS: ${err.message}. You can enter coordinates manually or adjust on the map grid.`
            : 'Unable to capture device GPS. Enter exact coordinates manually below.'
        );
        setGeoLoading(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  const handleGridPinClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !hasValidCoords) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width - 0.5;
    const relY = 0.5 - (e.clientY - rect.top) / rect.height;
    // Fine-tune +/- ~0.004 degrees (~400m box) around the current pin
    const nextLat = Math.max(-90, Math.min(90, parsedLat + relY * 0.004)).toFixed(6);
    const nextLng = Math.max(-180, Math.min(180, parsedLng + relX * 0.004)).toFixed(6);
    onChangeLatitude(nextLat);
    onChangeLongitude(nextLng);
    setGeoSuccess(`Adjusted map pin to ${nextLat}, ${nextLng}. Save Draft Profile to persist.`);
  };

  const osmEmbedUrl = hasValidCoords
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${(parsedLng - 0.004).toFixed(6)}%2C${(
        parsedLat - 0.004
      ).toFixed(6)}%2C${(parsedLng + 0.004).toFixed(6)}%2C${(parsedLat + 0.004).toFixed(
        6
      )}&layer=mapnik&marker=${parsedLat.toFixed(6)}%2C${parsedLng.toFixed(6)}`
    : null;

  return (
    <div className="p-space-md rounded-2xl bg-surface-container-low border border-surface-container flex flex-col gap-space-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h4 className="font-headline-sm text-label-lg font-bold text-on-surface flex items-center gap-1.5">
            <span className="material-symbols-outlined text-primary text-lg">location_on</span>
            <span>Physical Shop Address & GPS Coordinates</span>
          </h4>
          <p className="font-body-sm text-xs text-on-surface-variant">
            StreetVerse verifies fixed physical shops. Stand at your storefront for device GPS or set exact coordinates.
          </p>
        </div>

        <button
          type="button"
          disabled={disabled || geoLoading}
          onClick={handleCaptureBrowserGps}
          className="px-3 py-2 rounded-xl bg-primary text-on-primary font-label-sm text-xs font-bold flex items-center gap-1.5 self-start disabled:opacity-50 disabled:cursor-not-allowed stitch-btn"
        >
          <span className="material-symbols-outlined text-sm">
            {geoLoading ? 'progress_activity' : 'my_location'}
          </span>
          <span>{geoLoading ? 'Capturing GPS...' : 'Capture Current GPS'}</span>
        </button>
      </div>

      {reverificationRequired && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-900 dark:text-amber-200 text-xs font-semibold flex items-start gap-2"
        >
          <span className="material-symbols-outlined text-base shrink-0 mt-0.5">warning</span>
          <div>
            <p className="font-bold">Location Re-verification Required Before Store Re-approval</p>
            <p className="font-normal mt-0.5">
              {reverificationReason ||
                'Your shop location was updated after initial verification. Save accurate address & GPS coordinates, upload fresh storefront/premises proof if needed, and resubmit for Admin review.'}
            </p>
          </div>
        </div>
      )}

      {!reverificationRequired && locationChangeWarning && (
        <div
          role="note"
          className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-semibold flex items-start gap-2"
        >
          <span className="material-symbols-outlined text-base shrink-0 mt-0.5">info</span>
          <span>{locationChangeWarning}</span>
        </div>
      )}

      {geoError && (
        <div role="alert" className="p-2.5 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
          {geoError}
        </div>
      )}

      {geoSuccess && (
        <div className="p-2.5 rounded-xl bg-secondary/10 border border-secondary/30 text-secondary text-xs font-semibold">
          {geoSuccess}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-space-sm">
        <div className="md:col-span-2">
          <label className="font-label-sm text-xs font-semibold text-on-surface block mb-1">
            Physical Shop Street Address *
          </label>
          <input
            type="text"
            required
            disabled={disabled}
            value={address}
            onChange={(e) => onChangeAddress(e.target.value)}
            placeholder="Shop No, Building, Lane, Landmark, City"
            className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </div>

        <div>
          <label className="font-label-sm text-xs font-semibold text-on-surface block mb-1">
            6-Digit Pincode *
          </label>
          <input
            type="text"
            required
            disabled={disabled}
            maxLength={6}
            value={pincode}
            onChange={(e) => onChangePincode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="411038"
            className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-2 text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
        <div>
          <label className="font-label-sm text-xs font-semibold text-on-surface block mb-1">
            Latitude (-90 to 90) *
          </label>
          <input
            type="number"
            step="any"
            disabled={disabled}
            value={latitude}
            onChange={(e) => onChangeLatitude(e.target.value)}
            placeholder="e.g. 18.507400"
            className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-2 text-sm font-mono text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </div>

        <div>
          <label className="font-label-sm text-xs font-semibold text-on-surface block mb-1">
            Longitude (-180 to 180) *
          </label>
          <input
            type="number"
            step="any"
            disabled={disabled}
            value={longitude}
            onChange={(e) => onChangeLongitude(e.target.value)}
            placeholder="e.g. 73.807700"
            className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-2 text-sm font-mono text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </div>

        <div>
          <label className="font-label-sm text-xs font-semibold text-on-surface block mb-1">
            GPS Accuracy (meters)
          </label>
          <input
            type="number"
            step="any"
            min="0"
            disabled={disabled}
            value={gpsAccuracyMeters}
            onChange={(e) => onChangeGpsAccuracy(e.target.value)}
            placeholder="e.g. 12"
            className="w-full bg-surface-container-lowest border border-surface-container rounded-xl px-3 py-2 text-sm font-mono text-on-surface outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </div>
      </div>

      {hasValidCoords ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-sm mt-1">
          <div className="rounded-xl overflow-hidden border border-surface-container bg-surface-container-lowest h-48 relative">
            <iframe
              title="Selected Store Location Map"
              src={osmEmbedUrl!}
              className="w-full h-full border-0"
              loading="lazy"
            />
          </div>
          <div
            onClick={handleGridPinClick}
            role="button"
            tabIndex={disabled ? -1 : 0}
            className={`rounded-xl border border-dashed border-outline/40 bg-surface-container-lowest h-48 p-3 flex flex-col justify-between relative overflow-hidden ${
              disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-crosshair hover:border-primary'
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-on-surface">Fine-Tune Pin Position</span>
              <span className="font-mono text-outline">
                {parsedLat.toFixed(6)}, {parsedLng.toFixed(6)}
              </span>
            </div>
            <div className="flex-1 flex items-center justify-center relative my-1 bg-surface-container-low rounded-lg border border-surface-container">
              <div className="flex flex-col items-center text-primary pointer-events-none">
                <span className="material-symbols-outlined text-3xl">location_on</span>
                <span className="text-[11px] font-semibold">Click anywhere in box to nudge (~400m span)</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-on-surface-variant">
              <span>
                {gpsCapturedAt ? `Last saved GPS: ${new Date(gpsCapturedAt).toLocaleString()}` : 'Unsaved pin position'}
              </span>
              <a
                href={`https://www.openstreetmap.org/?mlat=${parsedLat}&mlon=${parsedLng}#map=18/${parsedLat}/${parsedLng}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary font-semibold hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Open Map ↗
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3 rounded-xl border border-dashed border-outline/40 bg-surface-container-lowest text-xs text-on-surface-variant text-center">
          Enter valid shop latitude and longitude or click &ldquo;Capture Current GPS&rdquo; to preview your storefront map pin.
        </div>
      )}
    </div>
  );
};
