/* globals describe, it, expect, beforeAll, afterAll */

const {
  resolveTravelDateWindow,
  resolvePurchaseDateWindow,
} = require('./itinerary-search');

/**
 * Freeze time so "today-based" default windows are deterministic.
 * TRAVEL_WINDOW_SPAN_YEARS = 2, so the full span is 24 months.
 *
 * Anchored to 2025-06-15:
 *   today - 24 months = 2023-06-15
 *   today + 24 months = 2027-06-15
 */
const FROZEN_NOW = new Date('2025-06-15T00:00:00.000Z');

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// resolveTravelDateWindow
// ---------------------------------------------------------------------------

describe('resolveTravelDateWindow', () => {
  describe('both dates provided', () => {
    it('returns the range unchanged when it fits within 24 months', () => {
      expect(resolveTravelDateWindow('2025-01-01', '2025-06-30'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('caps `to` at start + 24 months when the range exceeds 2 years', () => {
      expect(resolveTravelDateWindow('2024-01-01', '2030-12-31'))
        .toEqual({ from: '2024-01-01', to: '2026-01-01' });
    });

    it('normalises reversed dates (end before start)', () => {
      expect(resolveTravelDateWindow('2025-06-30', '2025-01-01'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('strips time components from both dates', () => {
      expect(resolveTravelDateWindow(
        '2025-01-01T10:00:00.000Z',
        '2025-06-30T23:59:59.997Z',
      )).toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('handles equal start and end dates', () => {
      expect(resolveTravelDateWindow('2025-03-10', '2025-03-10'))
        .toEqual({ from: '2025-03-10', to: '2025-03-10' });
    });
  });

  describe('only start date provided', () => {
    it('sets `to` to start + 24 months', () => {
      expect(resolveTravelDateWindow('2025-01-01', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('treats undefined end the same as null', () => {
      expect(resolveTravelDateWindow('2025-01-01', undefined))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('strips time component from start', () => {
      expect(resolveTravelDateWindow('2025-01-01T08:30:00.000Z', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });
  });

  describe('only end date provided', () => {
    it('sets `from` to end - 24 months', () => {
      expect(resolveTravelDateWindow(null, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined start the same as null', () => {
      expect(resolveTravelDateWindow(undefined, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });

  describe('no dates provided', () => {
    it('defaults to today - 24 months → today + 24 months', () => {
      expect(resolveTravelDateWindow(null, null))
        .toEqual({ from: '2023-06-15', to: '2027-06-15' });
    });

    it('treats undefined the same as null', () => {
      expect(resolveTravelDateWindow(undefined, undefined))
        .toEqual({ from: '2023-06-15', to: '2027-06-15' });
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePurchaseDateWindow
// ---------------------------------------------------------------------------

describe('resolvePurchaseDateWindow', () => {
  describe('both dates provided', () => {
    it('returns the range unchanged when it fits within 24 months', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', '2025-06-30'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('caps `to` at start + 24 months when the range exceeds 2 years', () => {
      expect(resolvePurchaseDateWindow('2023-01-01', '2030-12-31'))
        .toEqual({ from: '2023-01-01', to: '2025-01-01' });
    });

    it('normalises reversed dates (end before start)', () => {
      expect(resolvePurchaseDateWindow('2025-06-30', '2025-01-01'))
        .toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('strips time components from both dates', () => {
      expect(resolvePurchaseDateWindow(
        '2025-01-01T10:00:00.000Z',
        '2025-06-30T23:59:59.997Z',
      )).toEqual({ from: '2025-01-01', to: '2025-06-30' });
    });

    it('handles equal start and end dates', () => {
      expect(resolvePurchaseDateWindow('2025-03-10', '2025-03-10'))
        .toEqual({ from: '2025-03-10', to: '2025-03-10' });
    });
  });

  describe('only start date provided', () => {
    it('sets `to` to start + 24 months', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', null))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });

    it('treats undefined end the same as null', () => {
      expect(resolvePurchaseDateWindow('2025-01-01', undefined))
        .toEqual({ from: '2025-01-01', to: '2027-01-01' });
    });
  });

  describe('only end date provided', () => {
    it('sets `from` to end - 24 months', () => {
      expect(resolvePurchaseDateWindow(null, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined start the same as null', () => {
      expect(resolvePurchaseDateWindow(undefined, '2025-06-15'))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });

  describe('no dates provided', () => {
    it('defaults to today - 24 months → today (purchases are in the past)', () => {
      expect(resolvePurchaseDateWindow(null, null))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });

    it('treats undefined the same as null', () => {
      expect(resolvePurchaseDateWindow(undefined, undefined))
        .toEqual({ from: '2023-06-15', to: '2025-06-15' });
    });
  });
});
