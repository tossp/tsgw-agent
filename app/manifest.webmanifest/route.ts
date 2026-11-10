import type { MetadataRoute } from "next";
import { piManifestIcons } from "../../tsgw/branding";

export const dynamic = "force-dynamic";

export function GET() {
  const appName = process.env.PI_WEB_APP_NAME?.trim() || "Pi Web";
  const manifest: MetadataRoute.Manifest = {
    id: "/",
    name: appName,
    short_name: appName,
    description: "Local web interface for the pi coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1a1a1a",
    categories: ["developer", "productivity"],
    lang: "en",
    icons: piManifestIcons,
  };

  return Response.json(manifest, {
    headers: { "content-type": "application/manifest+json" },
  });
}
