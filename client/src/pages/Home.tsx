/*
 * Home — Face Breath
 * Bio-Lab Noir theme, scrollable layout for iPhone Safari.
 * Removed fixed/overflow-hidden so all UI elements are reachable by scrolling.
 */
import BreathingVisualizer from "@/components/BreathingVisualizer";

export default function Home() {
  return (
    <div style={{ minHeight: "100dvh", background: "#060b14", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      <BreathingVisualizer />
    </div>
  );
}
