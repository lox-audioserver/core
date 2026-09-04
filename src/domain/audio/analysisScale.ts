/**
 * The dB window the u16 analysis values on the wire span.
 *
 * `loudness`, `spectrum` and `f_peak` do not carry an amplitude: they carry the amplitude's
 * *position in dB* across [ANALYSIS_DB_FLOOR, 0] dBFS, linear in dB, as 0…65535. This is the
 * sendspin visualizer@v1 encoding, and it is the part consumers get wrong — taking `20·log10` of a
 * value that is already logarithmic maps a true −20 dBFS to 94% of full scale, which looks like
 * music that is permanently clipping.
 *
 * So: `dB = floor + (value / fullScale) · |floor|`, and a display height is `value / fullScale`
 * with no conversion at all.
 *
 * Stated here, in the domain, rather than as a constant each analyzer and each client re-declares
 * for itself: the engine's whole-file waveform, the application's live analyzer, the sendspin
 * visualizer and the public API all encode against this one window, and three of those four sit in
 * different layers.
 */
export const ANALYSIS_DB_FLOOR = -60;
export const ANALYSIS_FULL_SCALE = 65535;
