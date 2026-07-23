import type { Metadata } from "next";
import LostFound from "./lost-found/LostFound";

export const metadata: Metadata = {
  title: "Berlin Lost & Found｜Retrace your day, reach the right lost-property offices",
  description:
    "Lost something in Berlin? Retrace the public transport you took and the sights you visited, find every lost-property office responsible along the way, and generate ready-to-send German/English reports.",
};

export default function Home() {
  return <LostFound />;
}
