import assert from "node:assert/strict";
import test from "node:test";
import {
  reconstructPhotoAnchors,
  type PhotoPoint,
} from "../app/lost-found/photos";
import type { SearchItem } from "../app/lost-found/data";
import type { AttractionCategory } from "../app/berlin-transit/attractions";

function venue(
  refId: string,
  label: string,
  point: [number, number],
  category?: AttractionCategory
): SearchItem {
  return { kind: "venue", refId, label, sublabel: "", point, category, keywords: "" };
}

// ~1m in latitude degrees, for placing test venues at known distances.
const M = 1 / 111320;

const BRANDENBURGER = venue("bt", "Brandenburger Tor", [52.5163, 13.3777]);
const MUSEUM = venue("mi", "Museumsinsel", [52.5169, 13.4]);
const VENUES = [BRANDENBURGER, MUSEUM];

test("prefers a prominent landmark over an adjacent minor artwork", () => {
  const base = 52.5;
  const artworkNear = venue("art", "Some Sculpture", [base + 40 * M, 13.4], "artwork");
  const landmark = venue("lm", "Big Landmark", [base + 60 * M, 13.4], "landmark");
  const p: PhotoPoint[] = [{ lat: base, lng: 13.4, time: 1 }];
  // landmark is farther (60m) but weighted; artwork (40m) is closer — landmark wins.
  assert.equal(reconstructPhotoAnchors(p, [artworkNear, landmark])[0].venue?.refId, "lm");
  // but a much-closer artwork (5m) still beats a distant landmark (100m).
  const artworkVeryNear = venue("art2", "Sculpture", [base + 5 * M, 13.4], "artwork");
  const landmarkFar = venue("lm2", "Far Landmark", [base + 100 * M, 13.4], "landmark");
  assert.equal(
    reconstructPhotoAnchors(p, [artworkVeryNear, landmarkFar])[0].venue?.refId,
    "art2"
  );
});

test("photos without a timestamp sort after timed ones, and no points produce no anchors", () => {
  assert.deepEqual(reconstructPhotoAnchors([], VENUES), []);
  const points: PhotoPoint[] = [
    { lat: 52.5169, lng: 13.4, time: null }, // Museum, untimed
    { lat: 52.5163, lng: 13.3777, time: 50 }, // Brandenburger, timed first
  ];
  const venues = reconstructPhotoAnchors(points, VENUES)
    .map((anchor) => anchor.venue)
    .filter(Boolean);
  assert.deepEqual(
    venues.map((v) => v?.refId),
    ["bt", "mi"]
  );
});

test("keeps ordered photo anchors, raw coordinates, time, and nearest-sight distance", () => {
  const points: PhotoPoint[] = [
    { lat: 52.5169, lng: 13.4, time: 200 },
    { lat: 52.5164, lng: 13.3778, time: 100 },
  ];
  const anchors = reconstructPhotoAnchors(points, VENUES);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].venue?.refId, "bt");
  assert.deepEqual(anchors[0].point, [52.5164, 13.3778]);
  assert.equal(anchors[0].time, 100);
  assert.ok(anchors[0].distanceM != null && anchors[0].distanceM < 20);
  assert.equal(anchors[1].venue?.refId, "mi");
});

test("collapses repeat photos at one stop but retains their photo count", () => {
  const points: PhotoPoint[] = [
    { lat: 52.5163, lng: 13.3777, time: 100 },
    { lat: 52.51631, lng: 13.37771, time: 200 },
    { lat: 52.5169, lng: 13.4, time: 300 },
  ];
  const anchors = reconstructPhotoAnchors(points, VENUES);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].venue?.refId, "bt");
  assert.equal(anchors[0].photoCount, 2);
  assert.equal(anchors[1].photoCount, 1);
});

test("retains an unmatched GPS point as a route anchor", () => {
  const points: PhotoPoint[] = [{ lat: 52.55, lng: 13.45, time: 100 }];
  const anchors = reconstructPhotoAnchors(points, VENUES);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].venue, null);
  assert.deepEqual(anchors[0].point, [52.55, 13.45]);
});

test("groups consecutive photos within 300 metres before matching a venue", () => {
  const base = 52.5;
  const points: PhotoPoint[] = [
    { lat: base, lng: 13.4, time: 100 },
    { lat: base + 250 * M, lng: 13.4, time: 200 },
    { lat: base + 700 * M, lng: 13.4, time: 300 },
  ];
  const anchors = reconstructPhotoAnchors(points, []);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].photoCount, 2);
  assert.ok(Math.abs(anchors[0].point[0] - (base + 125 * M)) < M);
  assert.equal(anchors[0].time, 100);
  assert.equal(anchors[1].photoCount, 1);
});

test("allows a smaller merge radius when distinct nearby stops must be kept", () => {
  const base = 52.5;
  const points: PhotoPoint[] = [
    { lat: base, lng: 13.4, time: 100 },
    { lat: base + 150 * M, lng: 13.4, time: 200 },
  ];
  assert.equal(reconstructPhotoAnchors(points, [], 220, 100).length, 2);
  assert.equal(reconstructPhotoAnchors(points, [], 220, 300).length, 1);
});
