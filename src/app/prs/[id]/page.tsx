"use client";
/* OWNER: W9. PR detail. Next 15: client page reads params via useParams(). */
import "@/components/pr/pr.css";
import { useParams } from "next/navigation";
import { Detail } from "@/components/pr/Detail";

export default function PRDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ""));
  return <Detail key={id} id={id} />;
}
