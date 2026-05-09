import { useEffect } from "react";
import { useLocation } from "wouter";

export default function SettingsPage() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/government");
  }, [setLocation]);

  return null;
}
