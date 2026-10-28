"use client";

import NextError from "next/error";
import { useEffect } from "react";
import { reportCatError } from "@/lib/cat-monitoring";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportCatError(error, { source: "react-render", digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body><NextError statusCode={0} /></body>
    </html>
  );
}
