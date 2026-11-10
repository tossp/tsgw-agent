import type { Metadata, MetadataRoute } from "next";

export const PI_ICON_URL = "/icons/pi-blocks.svg";
export const PI_APPLE_ICON_URL = "/icons/pi-blocks-180.png";

export const piMetadataIcons: Metadata["icons"] = {
  icon: [{ url: PI_ICON_URL, sizes: "any", type: "image/svg+xml" }],
  apple: [{ url: PI_APPLE_ICON_URL, sizes: "180x180", type: "image/png" }],
};

export const piManifestIcons: MetadataRoute.Manifest["icons"] = [
  { src: PI_ICON_URL, sizes: "any", type: "image/svg+xml", purpose: "any" },
];
