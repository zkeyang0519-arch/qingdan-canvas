import React, { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs.jsx";
import "./workspace-information.css";

export default function ProjectResources({
  initialTab = "overview",
  summary,
  memories,
  error,
}) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <section
      className="studio-resource qd-project-resources"
      aria-label="项目资料"
    >
      <header className="studio-page-heading">
        <div>
          <small>当前项目</small>
          <h2>项目资料</h2>
          <p className="studio-heading-description">
            了解当前进展，保留以后仍需遵循的约定与经验。
          </p>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="项目资料分类">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="agreements">约定与经验</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" forceMount hidden={tab !== "overview"}>
          {summary}
        </TabsContent>
        <TabsContent
          value="agreements"
          forceMount
          hidden={tab !== "agreements"}
        >
          {error && (
            <p role="alert" className="agent-error">
              {error}
            </p>
          )}
          {memories}
        </TabsContent>
      </Tabs>
    </section>
  );
}
