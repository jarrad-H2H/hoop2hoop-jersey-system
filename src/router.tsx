// FILE: src/router.tsx
import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";

// Pages
import Login from "./pages/Login";
import ResetPassword from "./pages/ResetPassword";
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
import CompetitionGenderAdmin from "./pages/CompetitionGenderAdmin";
import CrossClubSearch from "./pages/CrossClubSearch";
import NumberReport from "./pages/NumberReport";
import SystemHealth from "./pages/SystemHealth";
import PreOrderManager from "./pages/PreOrderManager";
import UserManagement from "./pages/UserManagement";

// Components
import Importer from "./components/Importer";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import JerseyWidget from "./components/JerseyWidget";
import WidgetDemo from "./pages/WidgetDemo";

const AppRouter: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/embed/widget-demo" element={<JerseyWidget />} />
      <Route path="/embed/preorder" element={<JerseyWidget />} />

      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<ClubOverview />} />
        <Route path="club-overview" element={<ClubOverview />} />
        <Route path="clubs" element={<ClubManager />} />
        <Route path="inventory" element={<InventoryManager />} />
        <Route path="product-mapping" element={<ProductClubMapping />} />
        <Route path="players" element={<Players />} />
        <Route path="allocation" element={<Allocation />} />
        <Route path="allocation-history" element={<AllocationHistory />} />
        <Route path="importer" element={<Importer />} />
        <Route path="settings" element={<DataSettings />} />
        <Route path="competition-gender" element={<CompetitionGenderAdmin />} />
        <Route path="cross-club-search" element={<CrossClubSearch />} />
        <Route path="number-report" element={<NumberReport />} />
        <Route path="system-health" element={<SystemHealth />} />
        <Route path="stock-planner" element={<StockPlanner />} />
        <Route path="inventory/bulk-upload/:clubId" element={<BulkStockUpload />} />
        <Route path="sales-history" element={<SalesHistory />} />
        <Route path="preorder" element={<PreOrderManager />} />
        <Route path="users" element={<UserManagement />} />
        <Route path="widget-demo" element={<WidgetDemo />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};

export default AppRouter;
