import type { Metadata } from "next";
import TransitMap from "./berlin-transit/TransitMap";

export const metadata: Metadata = {
  title: "Berlin Trace｜用图钉与丝线串起柏林轨迹",
  description:
    "在柏林地图上用景点图钉、丝线与可拖动拐点记录轨迹，再推测可能的线路、上下车站与换乘。",
};

export default function Home() {
  return <TransitMap />;
}
