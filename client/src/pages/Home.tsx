/*
 * Home — Face Breath
 * Bio-Lab Noir theme, full-screen respiratory visualizer.
 * Single-page app: camera fills the screen, HUD overlaid.
 */
import BreathingVisualizer from "@/components/BreathingVisualizer";

export default function Home() {
  return (
    <div className="fixed inset-0 bg-background overflow-hidden">
      <BreathingVisualizer />
    </div>
  );
}
