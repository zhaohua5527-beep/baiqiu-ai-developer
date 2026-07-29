import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { BrandStatement, TaskJourney } from "@/components/BrandStatement";
import { Capabilities } from "@/components/Capabilities";
import { WorkflowDemo } from "@/components/WorkflowDemo";
import { UseCases } from "@/components/UseCases";
import { DesktopAssistant } from "@/components/DesktopAssistant";
import { ProductShowcase } from "@/components/ProductShowcase";
import { FinalCTA } from "@/components/FinalCTA";
import { FAQ } from "@/components/FAQ";
import { Footer } from "@/components/Footer";
import { PageLoader } from "@/components/PageLoader";

export default function HomePage() {
  return (
    <div className="site-shell">
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <PageLoader />
      <Header />
      <main id="main">
        <Hero />
        <BrandStatement />
        <TaskJourney />
        <Capabilities />
        <WorkflowDemo />
        <UseCases />
        <DesktopAssistant />
        <ProductShowcase />
        <FinalCTA />
        <FAQ />
      </main>
      <Footer />
    </div>
  );
}
