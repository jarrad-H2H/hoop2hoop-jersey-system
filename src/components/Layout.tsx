// FILE: src/components/Layout.tsx
import React from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import {
  LayoutDashboard,
  Users,
  Shirt,
  Database,
  Upload,
  LogOut,
  Settings,
  BarChart3,
  Link2,
  ShoppingBag,
  KeyRound,
  SplitSquareVertical,
  Search,
  Activity,
  FileSpreadsheet,
  ClipboardList,
} from "lucide-react";

type NavItem = {
  path: string;
  label: string;
  icon: React.ReactNode;
  match?: (pathname: string) => boolean;
};

const Layout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  const navItems: NavItem[] = [
    {
      path: "/admin",
      label: "Dashboard",
      icon: <LayoutDashboard size={20} />,
      match: (p) => p === "/admin" || p === "/admin/club-overview",
    },
    {
      path: "/admin/system-health",
      label: "System Health",
      icon: <Activity size={20} />,
      match: (p) => p.startsWith("/admin/system-health"),
    },
    {
      path: "/admin/clubs",
      label: "Club Manager",
      icon: <Users size={20} />,
      match: (p) => p.startsWith("/admin/clubs"),
    },
    {
      path: "/admin/inventory",
      label: "Inventory",
      icon: <Shirt size={20} />,
      match: (p) => p.startsWith("/admin/inventory"),
    },
    {
      path: "/admin/product-mapping",
      label: "Product Mapping",
      icon: <Link2 size={20} />,
      match: (p) => p.startsWith("/admin/product-mapping"),
    },
    {
      path: "/admin/players",
      label: "Players",
      icon: <Users size={20} />,
      match: (p) => p.startsWith("/admin/players"),
    },
    {
      path: "/admin/cross-club-search",
      label: "Cross-Club Search",
      icon: <Search size={20} />,
      match: (p) => p.startsWith("/admin/cross-club-search"),
    },
    {
      path: "/admin/number-report",
      label: "Number Report",
      icon: <FileSpreadsheet size={20} />,
      match: (p) => p.startsWith("/admin/number-report"),
    },
    {
      path: "/admin/allocation",
      label: "Number Allocation",
      icon: <Shirt size={20} />,
      match: (p) => p.startsWith("/admin/allocation"),
    },
    {
      path: "/admin/allocation-history",
      label: "Allocation History",
      icon: <Database size={20} />,
      match: (p) => p.startsWith("/admin/allocation-history"),
    },
    {
      path: "/admin/sales-history",
      label: "Sales History",
      icon: <ShoppingBag size={20} />,
      match: (p) => p.startsWith("/admin/sales-history"),
    },
    {
      path: "/admin/preorder",
      label: "Pre-Order Manager",
      icon: <ClipboardList size={20} />,
      match: (p) => p.startsWith("/admin/preorder"),
    },
    {
      path: "/admin/stock-planner",
      label: "Stock Planner",
      icon: <BarChart3 size={20} />,
      match: (p) => p.startsWith("/admin/stock-planner"),
    },
    {
      path: "/admin/importer",
      label: "CSV Importer",
      icon: <Upload size={20} />,
      match: (p) => p.startsWith("/admin/importer"),
    },
    {
      path: "/admin/competition-gender",
      label: "Competition Gender",
      icon: <SplitSquareVertical size={20} />,
      match: (p) => p.startsWith("/admin/competition-gender"),
    },
    {
      path: "/admin/settings",
      label: "Data Settings",
      icon: <Settings size={20} />,
      match: (p) => p.startsWith("/admin/settings"),
    },
    {
      path: "/admin/widget-demo",
      label: "Widget Demo",
      icon: <Database size={20} />,
      match: (p) => p.startsWith("/admin/widget-demo"),
    },
  ];

  const pathname = location.pathname;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-white text-slate-700 flex-shrink-0 flex flex-col border-r border-gray-200">
        <div className="p-6 border-b border-gray-200">
          <img src="/h2h-logo.png" alt="Hoop2Hoop" className="h-10 w-auto" />
          <p className="text-xs text-brandGray-500 mt-2">Jersey Management System</p>
        </div>

        <nav className="p-4 space-y-2 flex-1">
          {navItems.map((item) => {
            const isActive = item.match ? item.match(pathname) : pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-slate-600 hover:bg-brand-50 hover:text-brand-700"
                }`}
              >
                {item.icon}
                <span className="font-medium text-sm">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-200 space-y-1">
          <Link
            to="/reset-password"
            className="flex items-center space-x-3 px-4 py-3 w-full text-slate-600 hover:bg-brand-50 hover:text-brand-700 rounded-lg transition-colors"
          >
            <KeyRound size={20} />
            <span className="font-medium text-sm">Change Password</span>
          </Link>
          <button
            onClick={handleLogout}
            className="flex items-center space-x-3 px-4 py-3 w-full text-left text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut size={20} />
            <span className="font-medium text-sm">Sign Out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto h-screen">
        <div className="p-8 max-w-7xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default Layout;
