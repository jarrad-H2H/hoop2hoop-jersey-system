// FILE: src/router.tsx
import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";

// Pages
import Login from "./pages/Login";
import ClubManager from "./pages/ClubManager";
import InventoryManager from "./pages/InventoryManager";
import DataSettings from "./pages/DataSettings";
import Players from "./pages/Players";
import Allocation from "./pages/Allocation";
import AllocationHistory from "./pages/AllocationHistory";
import ClubOverview from "./pages/ClubOverview";
import StockPlanner from "./pages/StockPlanner";
import BulkStockUpload from "./pages/BulkStockUpload";
import ProductClubMapping from "./pages/ProductClubMapping";
import SalesHistory from "./pages/SalesHistory";

// Components
import Importer from "./components/Importer";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import WidgetDemo from "./components/JerseyWidget";

const AppRouter: React.FC = () => {
  return (
    <Routes>
      {/* Public route */}
      <Route path="/login" element={<Login />} />

      {/* ✅ PUBLIC EMBED ROUTE (Shopify iframe loads this) */}
      <Route path="/embed/widget-demo" element={<WidgetDemo />} />

      {/* Protected admin area */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Dashboard */}
        <Route index element={<ClubOverview />} />
        <Route path="club-overview" element={<ClubOverview />} />

        {/* Managers */}
        <Route path="clubs" element={<ClubManager />} />
        <Route path="inventory" element={<InventoryManager />} />

        {/* NEW: Product mapping */}
        <Route path="product-mapping" element={<ProductClubMapping />} />

        {/* Players / Allocation */}
        <Route path="players" element={<Players />} />
        <Route path="allocation" element={<Allocation />} />
        <Route path="allocation-history" element={<AllocationHistory />} />

        {/* Tools */}
        <Route path="importer" element={<Importer />} />
        <Route path="settings" element={<DataSettings />} />
        <Route path="stock-planner" element={<StockPlanner />} />

        {/* Bulk upload */}
        <Route path="inventory/bulk-upload/:clubId" element={<BulkStockUpload />} />

        {/* Sales History */}
        <Route path="sales-history" element={<SalesHistory />} />

        {/* Widget Demo (admin view) */}
        <Route path="widget-demo" element={<WidgetDemo />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};

export default AppRouter;
