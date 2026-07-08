/*
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";

const PricingSection = () => {
  const plans = [
    {
      name: "Free",
      price: "$0",
      period: "forever",
      description: "Perfect for trying it out",
      features: [
        "1 free scout report",
        "Basic opening analysis",
        "60-second summaries",
        "Pregame checklists",
        "Community support"
      ],
      cta: "Try Free",
      highlighted: false
    },
    {
      name: "Pro",
      price: "$12",
      period: "per month",
      description: "For serious competitors",
      features: [
        "Unlimited scout reports",
        "Deep engine analysis",
        "Time pressure patterns",
        "Training drill positions",
        "Downloadable JSON reports",
        "Priority support",
        "Advanced confidence scoring"
      ],
      cta: "Start Pro Trial",
      highlighted: true
    },
    {
      name: "Team",
      price: "$49",
      period: "per month",
      description: "For coaches and clubs",
      features: [
        "Everything in Pro",
        "Up to 10 team members",
        "API access",
        "Bulk report generation",
        "Team dashboard",
        "Custom integrations",
        "Dedicated support"
      ],
      cta: "Contact Sales",
      highlighted: false
    }
  ];

  return (
    <section id="pricing" className="py-20 bg-muted/30">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            Simple, Transparent Pricing
          </h2>
          <p className="text-lg text-muted-foreground">
            Start free. Upgrade when you're ready to dominate.
          </p>
        </div>
        
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan) => (
            <Card 
              key={plan.name} 
              className={plan.highlighted ? "border-primary shadow-lg relative" : ""}
            >
              {plan.highlighted && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4 py-1 rounded-full text-sm font-medium">
                  Most Popular
                </div>
              )}
              <CardHeader>
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                <div className="pt-4">
                  <span className="text-4xl font-bold text-foreground">{plan.price}</span>
                  <span className="text-muted-foreground ml-2">/{plan.period}</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      <span className="text-sm text-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button 
                  className="w-full" 
                  variant={plan.highlighted ? "default" : "outline"}
                  asChild
                >
                  <Link to={plan.name === "Team" ? "/auth" : "/auth"}>
                    {plan.cta}
                  </Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default PricingSection;
*/
