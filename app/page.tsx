import type { Metadata } from "next";
import TransitMap from "./berlin-transit/TransitMap";

export const metadata: Metadata = {
  title: "Berlin Trace｜柏林公共交通轨迹推测",
  description:
    "在柏林地图上手绘历史行动轨迹，按顺序推测可能的线路、上下车站与换乘。",
};

export default function Home() {
  return <TransitMap />;
}
