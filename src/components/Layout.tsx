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
      path: "/admin/clubs",
      label: "Club Manager",
      icon: <Users size={20} />,
      match: (p) => p.startsWith("/admin/clubs"),
    },
    {
      path: "/admin/inventory",
      label: "Inventory",
      icon: <Shirt size={20} />,
      // Important: keep highlighted for bulk upload sub-route too
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
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-slate-900 text-white flex-shrink-0 flex flex-col">
        <div className="p-6 border-b border-slate-700">
          <h1 className="text-2xl font-bold tracking-tight text-orange-500">
            Hoop2Hoop
          </h1>
          <p className="text-xs text-slate-400 mt-1">Jersey Management System</p>
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
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {item.icon}
                <span className="font-medium text-sm">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <button
            onClick={handleLogout}
            className="flex items-center space-x-3 px-4 py-3 w-full text-left text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <LogOut size={20} />
            <span className="font-medium text-sm">Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto h-screen">
        <div className="p-8 max-w-7xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default Layout;
